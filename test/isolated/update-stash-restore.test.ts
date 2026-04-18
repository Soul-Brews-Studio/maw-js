/**
 * #551 — stash+restore invariants for `maw update` fallback path.
 *
 * Why source-structure tests instead of behavioral: the stash logic lives
 * inline inside runUpdate() and is gated by a Bun.spawn result. Bun.spawn
 * is a runtime global with no ergonomic mock (returning a fake
 * `{ exited }` is doable, but runUpdate also calls execSync, /dev/tty,
 * ghqFind, `which maw`, `maw --version`, etc. — end-to-end mocking costs
 * more than it earns for a 30-line block).
 *
 * Instead, treat the stash+restore block as a frozen-behavior source
 * contract. Each numbered test below corresponds to one of the 7 cases
 * from the test brief. If a refactor drops or reorders one of these
 * invariants, the test fails with a targeted message and the author can
 * re-justify the change.
 *
 * Companion runtime coverage: cmd-update-order.test.ts holds the broader
 * order invariants (REF_RE precedes bun-remove; add precedes remove).
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const cmdUpdateSrc = readFileSync(
  join(import.meta.dir, "../../src/cli/cmd-update.ts"),
  "utf-8",
);

describe("cmd-update stash+restore — source invariants (#551)", () => {
  // ── Path constants ────────────────────────────────────────────────────
  it("BIN path points at ~/.bun/bin/maw", () => {
    expect(cmdUpdateSrc).toMatch(
      /const\s+BIN\s*=\s*join\(\s*homedir\(\)\s*,\s*["']\.bun["']\s*,\s*["']bin["']\s*,\s*["']maw["']/,
    );
  });

  it("STASH is BIN with .prev suffix", () => {
    expect(cmdUpdateSrc).toMatch(/const\s+STASH\s*=\s*`\$\{BIN\}\.prev`/);
  });

  // ── Case 1: happy-path short-circuit ──────────────────────────────────
  it("case 1 — first install success gates out of fallback (only retry after installCode !== 0)", () => {
    // The stash/remove/retry block must be inside an `if (installCode !== 0)` guard,
    // so a first-attempt success skips all stash machinery.
    expect(cmdUpdateSrc).toMatch(
      /let\s+installCode\s*=\s*await\s+spawnInstall\(\)\.exited\s*;[\s\S]*?if\s*\(\s*installCode\s*!==\s*0\s*\)\s*\{/,
    );
  });

  // ── Case 2: binary exists → stash rename happens ──────────────────────
  it("case 2 — stash renames BIN → STASH only when BIN exists", () => {
    // existsSync(BIN) guard wraps the renameSync(BIN, STASH) call.
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*existsSync\(BIN\)\s*\)\s*\{[\s\S]*?renameSync\(BIN\s*,\s*STASH\)/,
    );
  });

  // ── Case 3: binary missing → stash skipped, retry still runs ──────────
  it("case 3 — missing BIN leaves stashed=false, retry still runs", () => {
    // `stashed` starts false, is only set true inside the existsSync(BIN) branch.
    expect(cmdUpdateSrc).toMatch(/let\s+stashed\s*=\s*false\s*;/);
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*existsSync\(BIN\)\s*\)\s*\{[\s\S]*?stashed\s*=\s*true\s*;/,
    );
    // Retry spawnInstall sits OUTSIDE the existsSync(BIN) branch and AFTER the
    // try/execSync bun-remove line, so a missing BIN does not short-circuit it.
    // `let installCode = ...` is the FIRST call; the retry re-assigns without `let`.
    const retryIdx = cmdUpdateSrc.lastIndexOf(
      "installCode = await spawnInstall().exited",
    );
    const firstIdx = cmdUpdateSrc.indexOf(
      "let installCode = await spawnInstall().exited",
    );
    const stashBlockEnd = cmdUpdateSrc.indexOf(
      "/* stash best-effort */",
    );
    expect(firstIdx).toBeGreaterThan(-1);
    expect(stashBlockEnd).toBeGreaterThan(firstIdx);
    expect(retryIdx).toBeGreaterThan(stashBlockEnd);
  });

  // ── Case 4: prior .prev REFUSE (architect's safety gotcha) ────────────
  it("case 4 — existing .prev refuses with process.exit(1) (does NOT overwrite)", () => {
    // If ~/.bun/bin/maw.prev already exists, it's a prior crash's last-known-good
    // escape hatch. Silently overwriting would destroy that. Refuse + hint user.
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*existsSync\(STASH\)\s*\)\s*\{[\s\S]*?process\.exit\(1\)/,
    );
    // Must NOT silently unlink old stash before rename
    expect(cmdUpdateSrc).not.toMatch(
      /unlinkSync\(STASH\)[\s\S]*?renameSync\(BIN\s*,\s*STASH\)/,
    );
  });

  // ── Case 5: retry success → stash cleaned up ──────────────────────────
  it("case 5 — retry success (installCode === 0) unlinks STASH", () => {
    expect(cmdUpdateSrc).toMatch(
      /else if\s*\(\s*installCode\s*===\s*0\s*&&\s*stashed\s*&&\s*existsSync\(STASH\)\s*\)\s*\{[\s\S]*?unlinkSync\(STASH\)/,
    );
  });

  // ── Case 6: retry fails → restore + warn ──────────────────────────────
  it("case 6 — retry failure restores STASH → BIN and warns", () => {
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*installCode\s*!==\s*0\s*&&\s*stashed\s*&&\s*existsSync\(STASH\)\s*\)\s*\{[\s\S]*?renameSync\(STASH\s*,\s*BIN\)/,
    );
    expect(cmdUpdateSrc).toContain("restored previous maw binary from stash");
  });

  it("case 6b — error path on failed restore logs 'failed to restore stash'", () => {
    // If the restore rename itself throws, we still surface the error so the user
    // knows manual recovery is needed.
    expect(cmdUpdateSrc).toMatch(/failed to restore stash/);
  });

  // ── Case 7: rename throws → best-effort, doesn't block retry ──────────
  it("case 7 — stash rename is wrapped in try/catch (best-effort)", () => {
    // The stash attempt is inside try { ... } catch { /* stash best-effort */ }.
    // A permission error on rename must not block the retry that follows.
    expect(cmdUpdateSrc).toMatch(
      /try\s*\{[\s\S]*?renameSync\(BIN\s*,\s*STASH\)[\s\S]*?\}\s*catch\s*\{\s*\/\*\s*stash best-effort\s*\*\/\s*\}/,
    );
  });

  // ── Cross-cutting order invariants ────────────────────────────────────
  it("bun remove runs AFTER stash block (BIN already moved to STASH)", () => {
    const renameIdx = cmdUpdateSrc.search(/renameSync\(BIN\s*,\s*STASH\)/);
    const removeIdx = cmdUpdateSrc.search(/execSync\(\s*`bun remove -g maw`/);
    expect(renameIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    expect(renameIdx).toBeLessThan(removeIdx);
  });

  it("retry spawnInstall runs AFTER bun remove", () => {
    const removeIdx = cmdUpdateSrc.search(/execSync\(\s*`bun remove -g maw`/);
    // Second occurrence of `spawnInstall().exited` is the retry.
    const addRe = /spawnInstall\(\)\.exited/g;
    const matches: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = addRe.exec(cmdUpdateSrc)) !== null) matches.push(m.index);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[1]).toBeGreaterThan(removeIdx);
  });

  it("final exit code propagates installCode on total failure", () => {
    // If both installs fail, process.exit(installCode) surfaces the real code
    // to the caller so scripted update flows can react.
    expect(cmdUpdateSrc).toMatch(/process\.exit\(installCode\)/);
  });
});
