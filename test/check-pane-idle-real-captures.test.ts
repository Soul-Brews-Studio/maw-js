/**
 * check-pane-idle-real-captures.test.ts — checkPaneIdle against REAL Claude Code
 * pane captures (#eq3-003b / #eq3-003c).
 *
 * The eq3-003b/003c regressions both slipped past review because the tests used
 * a shell pane / hand-built fixtures, not real Claude Code TUI output. These
 * fixtures ARE real `tmux capture-pane -e` snapshots (test/fixtures/pane-captures,
 * m5 2026-06-25) fed straight through the captureFn seam — the representative
 * coverage that was missing.
 *
 * #eq3-003c specifically: Claude Code renders ghost/queued/placeholder text on
 * the input row as DIM (`ESC[2m … ESC[0m`, sometimes unclosed to EOL). A CSI-only
 * strip removed only the dim codes, leaving the ghost TEXT, which read as live
 * operator input → false "typing" → every pane with a queued message was
 * over-deferred. The fix strips the whole dim span first.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { checkPaneIdle, detectPermissionMenu } from "../src/commands/shared/comm-send";

const FX = join(import.meta.dir, "fixtures/pane-captures");
const probe = (file: string) =>
  checkPaneIdle("pane:0.0", undefined, {
    captureFn: async () => readFileSync(join(FX, file), "utf8"),
  });
const probeMenu = (content: string) =>
  detectPermissionMenu("pane:0.0", undefined, { captureFn: async () => content });
const probeMenuFile = (file: string) => probeMenu(readFileSync(join(FX, file), "utf8"));

describe("checkPaneIdle — real Claude Code pane captures (#eq3-003b/003c)", () => {
  test("dim ghost text (per-word ESC[2m…ESC[0m) is idle, not 'typing'", async () => {
    const r = await probe("claude-dim-ghost-perword.txt");
    expect(r.idle).toBe(true);
    expect(r.lastInput).toBe("");
  });

  test("dim ghost text (unclosed ESC[2m running to end-of-line) is idle", async () => {
    const r = await probe("claude-dim-ghost-eol.txt");
    expect(r.idle).toBe(true);
    expect(r.lastInput).toBe("");
  });

  test("autosuggest with compound dim opener (ESC[7m<char> + ESC[0;2m…) is idle", async () => {
    // Real eq3 capture, m5 2026-07-04: the cursor block sits ON the first ghost
    // char (`ESC[7mร`) and the rest opens with COMPOUND reset+dim `ESC[0;2m`,
    // which the plain `ESC[2m` span-strip missed → false "typing".
    const r = await probe("claude-autosuggest-compound-dim.txt");
    expect(r.idle).toBe(true);
    expect(r.lastInput).toBe("");
  });

  test("truly-empty input box is idle", async () => {
    const r = await probe("claude-empty.txt");
    expect(r.idle).toBe(true);
    expect(r.lastInput).toBe("");
  });

  test("bright (real) operator typing still defers — must not be stripped as ghost", async () => {
    const r = await probe("claude-bright-typing.txt");
    expect(r.idle).toBe(false);
    expect(r.lastInput).toContain("hello world");
  });

  test("permission menu (not dim) still defers — never inject into an open dialog", async () => {
    const r = await probe("claude-permission-menu.txt");
    expect(r.idle).toBe(false);
  });
});

describe("detectPermissionMenu — modal recognition (eq3-004)", () => {
  test("real Claude Code permission menu is detected (numbered cursor + Esc-to-cancel footer)", async () => {
    expect(await probeMenuFile("claude-permission-menu.txt")).toBe(true);
  });

  test("bright operator typing is NOT a menu (no modal footer)", async () => {
    expect(await probeMenuFile("claude-bright-typing.txt")).toBe(false);
  });

  test("empty input box is NOT a menu", async () => {
    expect(await probeMenuFile("claude-empty.txt")).toBe(false);
  });

  test("operator literally typing '1. ...' without a modal footer does NOT false-trigger", async () => {
    // The exact false-positive the dual-signal guard exists to prevent: a
    // numbered list on the prompt line, but none of the modal chrome.
    const typed = "\x1b[2m… some agent output …\x1b[0m\n❯ 1. buy milk and 2. eggs\n";
    expect(await probeMenu(typed)).toBe(false);
  });

  test("modal footer alone, with no numbered cursor, does NOT count as a menu", async () => {
    const footerOnly = "Press Esc to cancel the running task\n❯ \n";
    expect(await probeMenu(footerOnly)).toBe(false);
  });
});
