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

  // ── Release/bun install order ─────────────────────────────────────────
  it("release tags try curl binary before bun fallback", () => {
    const releaseGuardIdx = cmdUpdateSrc.indexOf("if (isReleaseTag)");
    const curlIdx = cmdUpdateSrc.indexOf('Bun.spawn(["curl", "-fsSL", "-o", BIN, releaseUrl]');
    const fallbackIdx = cmdUpdateSrc.indexOf("// Fallback: bun add -g");
    const bunAddIdx = cmdUpdateSrc.indexOf('Bun.spawn(["bun", "add", "-g"');

    expect(cmdUpdateSrc).toContain("const isReleaseTag = /^v\\d+\\.\\d+\\.\\d+/.test(ref);");
    expect(releaseGuardIdx).toBeGreaterThan(-1);
    expect(curlIdx).toBeGreaterThan(releaseGuardIdx);
    expect(fallbackIdx).toBeGreaterThan(curlIdx);
    expect(bunAddIdx).toBeGreaterThan(fallbackIdx);
  });

  // ── Case 1: happy-path short-circuit ──────────────────────────────────
  it("case 1 — successful install gates out of bun cleanup fallback", () => {
    // The stash/remove/retry block must be inside the bun fallback's
    // `if (installCode !== 0)` guard. For release tags, curl is tried first;
    // if curl succeeds, this whole bun fallback block is skipped. For branch
    // refs, a first-attempt bun success skips all stash machinery.
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*installCode\s*!==\s*0\s*\)\s*\{[\s\S]*?const\s+spawnInstall\s*=[\s\S]*?installCode\s*=\s*await\s+spawnInstall\(\)\.exited\s*;[\s\S]*?if\s*\(\s*installCode\s*!==\s*0\s*\)\s*\{/,
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
    const fallbackGuardIdx = cmdUpdateSrc.indexOf("if (installCode !== 0)");
    const stashBlockIdx = cmdUpdateSrc.indexOf("renameSync(BIN, STASH)");
    const retryIdx = cmdUpdateSrc.indexOf(
      "installCode = await spawnInstall().exited",
      stashBlockIdx,
    );
    expect(fallbackGuardIdx).toBeGreaterThan(-1);
    expect(stashBlockIdx).toBeGreaterThan(fallbackGuardIdx);
    expect(retryIdx).toBeGreaterThan(stashBlockIdx);
  });

  // ── Case 4: prior .prev ROTATE (#968 — auto-recover, don't block) ─────
  it("case 4 — existing .prev rotates to timestamped archive (does NOT overwrite, does NOT exit)", () => {
    // #968 — the original (#551) behavior refused with process.exit(1) when
    // STASH already existed. That left users stuck after a single crash:
    // the retry/curl-fallback path below could never run. Now we rotate the
    // stale STASH to `${STASH}.crash.<unix-timestamp>` instead, preserving
    // it for forensic recovery while unblocking the in-flight update.
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*existsSync\(STASH\)\s*\)\s*\{[\s\S]*?renameSync\(STASH\s*,\s*archived\)/,
    );
    // Must NOT exit on the happy rotate path (only on rotation failure)
    expect(cmdUpdateSrc).toMatch(
      /\$\{STASH\}\.crash\.\$\{Math\.floor\(Date\.now\(\) \/ 1000\)\}/,
    );
    // Must still NOT silently unlink old stash before rename of BIN
    expect(cmdUpdateSrc).not.toMatch(
      /unlinkSync\(STASH\)[\s\S]*?renameSync\(BIN\s*,\s*STASH\)/,
    );
  });

  // ── Case 4b: rotation failure preserves the original refuse behavior ───
  it("case 4b — rotation failure falls back to refuse + process.exit(1)", () => {
    // If renameSync(STASH, archived) throws (perms, disk full, etc.), we
    // restore the original "refuse to overwrite" safety net rather than
    // risk silently destroying the user's last-known-good binary.
    expect(cmdUpdateSrc).toMatch(
      /catch\s*\([^)]*\)\s*\{[\s\S]*?could not be rotated[\s\S]*?process\.exit\(1\)/,
    );
  });

  // ── Case 5: retry success → stash cleaned up only AFTER verify ────────
  it("case 5 — retry success unlinks STASH only after the fresh binary verifies", () => {
    // Restructured (crash-loop fix): the success branch is now `else { ... }`,
    // and the stash is discarded only inside the `freshOk` (verified-working)
    // sub-branch — never rotate away the old binary until the new one runs.
    expect(cmdUpdateSrc).toMatch(
      /const\s+freshOk\s*=\s*\(await\s+verify\.exited\)\s*===\s*0\s*;[\s\S]*?else\s*\{[\s\S]*?unlinkSync\(STASH\)/,
    );
  });

  // ── Case 6: retry fails → restore pkg dir + bin ────────────────────────
  it("case 6 — retry failure restores the package dir then STASH → BIN", () => {
    // Restructured (crash-loop fix): guard is now plain `if (installCode !== 0)`;
    // restorePkgStash() runs FIRST so the stashed bin symlink resolves again,
    // THEN restoreBinStash() moves STASH back to BIN.
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*installCode\s*!==\s*0\s*\)\s*\{[\s\S]*?restorePkgStash\(\)\s*;[\s\S]*?restoreBinStash\(\)\s*;/,
    );
    expect(cmdUpdateSrc).toMatch(
      /const\s+restoreBinStash\s*=\s*\(\)\s*=>\s*\{[\s\S]*?renameSync\(STASH\s*,\s*BIN\)/,
    );
  });

  it("case 6b — terminal failure prints manual recovery guidance", () => {
    expect(cmdUpdateSrc).toContain("install failed — previous maw restored from stash (if available)");
    expect(cmdUpdateSrc).toContain("Manual recovery");
  });

  // ── Case 8: maw-js package dir is stashed by RENAME, not rm ───────────
  it("case 8 — maw-js node_modules dir is stashed by rename (recoverable), not rm'd", () => {
    // The crash-loop root cause: rm'ing node_modules/maw-js orphaned the
    // stashed bin symlink, so existsSync(STASH) reported false and the
    // restore silently no-op'd — leaving NO working maw. Now the dir is
    // moved aside by rename so the restore path can put a *working* install
    // back (bin symlink + the package it resolves through).
    expect(cmdUpdateSrc).toMatch(
      /renameSync\(join\(NM,\s*"maw-js"\),\s*PKG_STASH\)\s*;\s*pkgStashed\s*=\s*true/,
    );
    // maw-js must NOT be in the outright-rm loop anymore
    expect(cmdUpdateSrc).not.toMatch(/for \(const name of \["maw-js",/);
  });

  // ── Case 9: verify-before-discard — rollback on broken "success" ──────
  it("case 9 — a 'successful' install whose binary does not run is rolled back", () => {
    // installCode === 0 is necessary but not sufficient: if `maw --version`
    // does not exit 0, restore the stash and fall into the error path.
    expect(cmdUpdateSrc).toMatch(
      /if\s*\(\s*!freshOk\s*\)\s*\{[\s\S]*?restorePkgStash\(\)[\s\S]*?installCode\s*=\s*1\s*;/,
    );
  });

  // ── Case 7: rename throws → best-effort, doesn't block retry ──────────
  it("case 7 — stash rename is wrapped in try/catch (best-effort)", () => {
    // A permission error on rename must not block the retry that follows.
    expect(cmdUpdateSrc).toMatch(
      /try\s*\{\s*if\s*\(existsSync\(BIN\)\)\s*\{\s*renameSync\(BIN\s*,\s*STASH\);\s*stashed\s*=\s*true;\s*\}\s*\}\s*catch\s*\{\s*\}/,
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
