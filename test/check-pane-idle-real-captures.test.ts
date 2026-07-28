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
import {
  checkPaneIdle,
  detectPermissionMenu,
  isSafeToInject,
  SEND_GATE_SNAPSHOT_LINES,
} from "../src/commands/shared/comm-send";

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
 * kobo-508 — the real permission menu (claude-permission-menu.txt) draws its
 * selected row in COLOUR (38;5;153), not reverse video. checkPaneIdle's
 * ghost-strip (kobo-503) deletes a whole reverse span; it has never had to
 * face a menu row drawn that way because Claude Code has never drawn one that
 * way. This shape is NOT OBSERVED on any real pane — constructed to match the
 * real menu's own structure (numbered cursor + "Esc to cancel" footer, from
 * claude-permission-menu.txt) with only the selected row's styling swapped
 * from colour to reverse. If Claude Code ever renders this way, checkPaneIdle
 * alone reads the pane as idle (proven below); isSafeToInject does not,
 * because detectPermissionMenu strips only ANSI codes, never a whole
 * attribute span, so its signal survives regardless of which way the row is
 * styled.
 */
describe("kobo-508 — permission-menu row drawn in reverse instead of colour (hypothetical, not yet observed)", () => {
  const reverseMenuPane = [
    " Do you want to proceed?",
    " \x1b[7m❯ 1. Yes\x1b[27m",
    "   2. Yes, and don't ask again for: maw inbox *",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
  ].join("\n");
  const captureFn = async () => reverseMenuPane;

  test("checkPaneIdle ALONE reads this as idle — the latent hole this card documents", async () => {
    // Not a regression to fix in stripGhostText itself: the whole point is that
    // checkPaneIdle can't tell dim/reverse text apart from a menu without help.
    const r = await checkPaneIdle("pane:0.0", undefined, { captureFn });
    expect(r.idle).toBe(true);
  });

  test("detectPermissionMenu still catches it — its strip never deletes the row", async () => {
    expect(await detectPermissionMenu("pane:0.0", undefined, { captureFn })).toBe(true);
  });

  test("isSafeToInject is the actual fix: unsafe, reason 'menu', despite checkPaneIdle alone saying idle", async () => {
    const r = await isSafeToInject("pane:0.0", undefined, { captureFn });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("menu");
  });

  test("isSafeToInject on real bright typing: unsafe, reason 'typing' (existing behaviour preserved)", async () => {
    const r = await isSafeToInject("pane:0.0", undefined, {
      captureFn: async () => readFileSync(join(FX, "claude-bright-typing.txt"), "utf8"),
    });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("typing");
  });

  test("isSafeToInject on a truly empty box: safe (existing behaviour preserved)", async () => {
    const r = await isSafeToInject("pane:0.0", undefined, {
      captureFn: async () => readFileSync(join(FX, "claude-empty.txt"), "utf8"),
    });
    expect(r.safe).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

/**
 * kobo-508 — checkPaneIdle and detectPermissionMenu must request the SAME
 * snapshot depth. Widening the window to catch a taller menu only works both
 * places if there's one declared source; if the two ever drift apart, one
 * gate reads a shorter (or taller) pane than the other and the hole this card
 * exists to close reopens silently, with no red test to catch it. This spies
 * on the raw captureFn args each function passes and pins both to the
 * exported constant. It catches the two call sites DIVERGING (e.g. one left
 * at 12, the other bumped to 40) — it does NOT prove either call site still
 * references the constant rather than a re-hardcoded literal that happens to
 * equal it; that class of regression is out of scope here (would need a
 * source-scan, which is more than this AC asks for).
 */
describe("kobo-508 — send-gate snapshot depth is declared once, used by both", () => {
  test("checkPaneIdle requests SEND_GATE_SNAPSHOT_LINES rows", async () => {
    const seen: number[] = [];
    await checkPaneIdle("pane:0.0", undefined, {
      captureFn: async (_t, lines) => { seen.push(lines as number); return ""; },
    });
    expect(seen).toEqual([SEND_GATE_SNAPSHOT_LINES]);
  });

  test("detectPermissionMenu requests SEND_GATE_SNAPSHOT_LINES rows", async () => {
    const seen: number[] = [];
    await detectPermissionMenu("pane:0.0", undefined, {
      captureFn: async (_t, lines) => { seen.push(lines as number); return ""; },
    });
    expect(seen).toEqual([SEND_GATE_SNAPSHOT_LINES]);
  });
});

/**
 * kobo-508 — the two items %11 raised while reviewing kobo-503 are recorded as
 * HYPOTHESES, not findings, per lead's explicit instruction: neither has been
 * observed on a real pane, and this card must not let either read as proven.
 *
 * 1. An input of EXACTLY one character with the cursor sitting on it may read
 *    as empty. %11 constructed this himself; he has never seen it on a real
 *    pane, and every real capture of actual operator typing on file (e.g.
 *    claude-bright-typing.txt) renders with NO reverse-video codes at all —
 *    the cursor does not visibly overlap real typed text in any artifact this
 *    fleet has captured tonight. I did not attempt to produce one live (would
 *    require sending a single real keystroke into a live Claude Code pane to
 *    capture the result, which risks overtyping someone's actual session for
 *    a hypothesis check) — leaving this UNTESTED, stated plainly, not
 *    converted to a finding either way.
 * 2. A pure-reverse/no-dim shape (no dim anywhere in the row) already passes
 *    checkPaneIdle correctly, but nothing in the committed suite asserted it
 *    directly. This one WAS convertible to a real finding: verified live
 *    against %11's own pane (13-patchwork:0.2, tmux pane %11) while it was
 *    showing exactly this shape mid-incident tonight (a bare placeholder
 *    ellipsis, cursor-reverse, zero dim) — real capture-pane -e bytes fed
 *    through checkPaneIdle returned idle:true. Committed below as a real
 *    fixture, not reconstructed.
 */
describe("kobo-508 hypothesis 2 (CONVERTED to finding): pure reverse, zero dim, real pane", () => {
  test("real capture (13-patchwork:0.2, mid-incident): reverse-only placeholder is idle", async () => {
    const r = await probe("claude-pure-reverse-no-dim.txt");
    expect(r.idle).toBe(true);
    expect(r.lastInput).toBe("");
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
