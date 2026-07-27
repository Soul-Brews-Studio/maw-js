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

/**
 * kobo-503 — the queued-message HINT row ("❯ Press up to edit queued messages").
 *
 * Claude Code draws this row whenever its client-side queue is non-empty. The
 * eq3-003c span-regex required the dim opener to be immediately followed by the
 * ghost text; the real emission interleaves a colour code (`ESC[2m ESC[39m …`),
 * and with the cursor block on the first char it splits differently again
 * (`ESC[7m ESC[39m P ESC[0;2m ress…`). Either way the ghost text survived the
 * strip and read as live typing — so a pane holding ONE queued message was
 * declared "operator input mid-edit" and every later message deferred, which
 * kept the hint on screen: a queue that blocks its own drain. Measured live
 * 2026-07-28: 20 messages pending, all attempts=0, `POST /api/flush` delivered
 * 0 of 12.
 */
describe("checkPaneIdle — queued-message hint is ghost, not typing (kobo-503)", () => {
  test("real capture: split dim opener (ESC[2m ESC[39m) reads as IDLE", async () => {
    const r = await probe("claude-queued-hint-split-dim.txt");
    expect(r.idle).toBe(true);
    expect(r.lastInput).toBe("");
  });

  test("cursor-block variant (ESC[7m … ESC[0;2m) reads as IDLE", async () => {
    // Byte-for-byte transcription of the same hint row as rendered with the
    // cursor block on its first character (live capture, 05-eq3:eq3-oracle.2,
    // 2026-07-28 04:57). Kept inline because the variant depends on cursor
    // position and cannot be re-captured on demand.
    const row = "\x1b[38;5;246m❯ \x1b[7m\x1b[39mP\x1b[0;2mress up to edit queued messages\x1b[0m";
    const pane = `agent output\n\x1b[38;5;246m142642 tokens\x1b[39m\n----\n${row}\n--\n  \x1b[32m online\x1b[39m\n`;
    const r = await checkPaneIdle("pane:0.0", undefined, { captureFn: async () => pane });
    expect(r.idle).toBe(true);
  });

  test("real typing on the same row shape is still NOT idle (guard still guards)", async () => {
    const row = "\x1b[38;5;246m❯ \x1b[39mreal operator text";
    const pane = `agent output\n----\n${row}\n--\n  \x1b[32m online\x1b[39m\n`;
    const r = await checkPaneIdle("pane:0.0", undefined, { captureFn: async () => pane });
    expect(r.idle).toBe(false);
    expect(r.lastInput).toBe("real operator text");
  });
});

/**
 * kobo-503 c1 — %5's request-change on the first cut of stripGhostText.
 *
 * SGR 38/48 (extended fg/bg) own the params that follow them: `38;5;2` is
 * palette index 2, `38;2;r;g;b` is truecolour. Reading params left-to-right
 * without consuming those made a colour's literal `2` set dim, which swallowed
 * the rest of the row — including text a human was actively typing. That is a
 * worse failure than the bug being fixed (this guard exists to stop overtyping)
 * and the regex it replaced did not have it. Caught by an independent reviewer
 * running the whole checkPaneIdle path, not by the author.
 */
describe("checkPaneIdle — colour params must not read as dim (kobo-503 c1)", () => {
  const row = (prefix: string) => `agent output\n----\n${prefix}❯ \x1b[39mreal typed text\n--\n  online\n`;

  test("256-colour foreground index 2 (38;5;2) does not hide typing", async () => {
    const r = await checkPaneIdle("p", undefined, { captureFn: async () => row("\x1b[38;5;2m") });
    expect(r.idle).toBe(false);
    expect(r.lastInput).toBe("real typed text");
  });

  test("truecolour foreground with a 2 in its channels (38;2;r;g;b) does not hide typing", async () => {
    const r = await checkPaneIdle("p", undefined, { captureFn: async () => row("\x1b[38;2;0;2;9m") });
    expect(r.idle).toBe(false);
  });

  test("underline colour 58;5;2 does not hide typing", async () => {
    const r = await checkPaneIdle("p", undefined, { captureFn: async () => row("\x1b[58;5;2m") });
    expect(r.idle).toBe(false);
  });

  test("256-colour BACKGROUND index 2 (48;5;2) does not hide typing", async () => {
    const r = await checkPaneIdle("p", undefined, { captureFn: async () => row("\x1b[48;5;2m") });
    expect(r.idle).toBe(false);
  });

  test("a standalone 2 IS still dim — the fix must not disarm the strip", async () => {
    const r = await checkPaneIdle("p", undefined, {
      captureFn: async () => "agent output\n----\n\x1b[38;5;246m❯ \x1b[2m\x1b[39mghost\x1b[0m\n--\n  online\n",
    });
    expect(r.idle).toBe(true);
  });
});
