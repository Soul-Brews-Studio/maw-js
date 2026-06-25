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
import { checkPaneIdle } from "../src/commands/shared/comm-send";

const FX = join(import.meta.dir, "fixtures/pane-captures");
const probe = (file: string) =>
  checkPaneIdle("pane:0.0", undefined, {
    captureFn: async () => readFileSync(join(FX, file), "utf8"),
  });

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
