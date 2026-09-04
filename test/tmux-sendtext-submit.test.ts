/**
 * tmux-sendtext-submit.test.ts — regression for maw-stress finding #6.
 *
 * Tmux.sendText used to fire 3 blind `Enter` keys on a fixed ~1.9s schedule
 * with zero feedback. When the pane wasn't ready as they landed, every Enter
 * missed and the command sat in the input box unexecuted — this forced
 * brain to manually re-launch dispatches on 2026-05-14.
 *
 * The fix: send Enter, re-inspect the pane, retry only while the input line
 * still holds un-submitted content (capped at MAX_SUBMIT_ATTEMPTS).
 *
 * Strategy: subclass Tmux and override the low-level primitives so we can
 * script the pane's capture output and assert the exact key sequence — no
 * tmux process, no module mock (safe for the main suite).
 */
import { describe, test, expect } from "bun:test";
import { Tmux, inputBoxRegion } from "../src/core/transport/tmux-class";

/** Tmux with the tmux-touching primitives stubbed + a scripted capture feed. */
class FakeTmux extends Tmux {
  calls: string[] = [];
  /** Successive return values for capture(); last value repeats once exhausted. */
  captureScript: string[] = [];
  private captureIdx = 0;

  constructor() {
    super(undefined, ""); // no socket — overridden methods never hit hostExec
  }

  async capture(_target: string, _lines = 80): Promise<string> {
    this.calls.push("capture");
    const v = this.captureScript[this.captureIdx] ?? this.captureScript.at(-1) ?? "";
    this.captureIdx++;
    return v;
  }
  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }
  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }
  async loadBuffer(text: string): Promise<void> {
    this.calls.push(`loadBuffer:${text.length}`);
  }
  async pasteBuffer(_target: string): Promise<void> {
    this.calls.push("pasteBuffer");
  }
  async exitModeIfNeeded(_target: string): Promise<boolean> {
    return false;
  }
}

const PROMPT_IDLE = "agent@host:~$ "; // prompt marker + trailing space → submitted
const PROMPT_PENDING = "agent@host:~$ unsent command text"; // input still on the line
const enterCount = (calls: string[]) => calls.filter(c => c === "sendKeys:Enter").length;

describe("Tmux.sendText — confirmed submit (#6)", () => {
  test(
    "single Enter when the pane clears on the first check — no blind trailing Enters",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [PROMPT_IDLE];
      await t.sendText("sess:win", "hello");

      expect(t.calls).toEqual(["sendKeysLiteral:hello", "sendKeys:Enter", "capture"]);
      expect(enterCount(t.calls)).toBe(1);
    },
    10_000,
  );

  test(
    "retries Enter while input is still pending, stops as soon as it clears",
    async () => {
      const t = new FakeTmux();
      // pending after Enter #1 and #2, cleared after #3
      t.captureScript = [PROMPT_PENDING, PROMPT_PENDING, PROMPT_IDLE];
      await t.sendText("sess:win", "deploy task");

      expect(enterCount(t.calls)).toBe(3);
      // last action is the confirming capture, not another blind Enter
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );


  test(
    "recognizes Codex U+203A prompts as pending via prompt fallback",
    async () => {
      const t = new FakeTmux();
      t.captureScript = ["› [m5:mawjs] codex-1: unrelated pending input", "› "];
      await t.sendText("sess:codex", "hello");

      expect(enterCount(t.calls)).toBe(2);
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );

  test(
    "detects pending input from the sent text without known prompt markers",
    async () => {
      const t = new FakeTmux();
      t.captureScript = ["ENGINE_PROMPT please handle this", "ENGINE_PROMPT "];
      await t.sendText("sess:any-engine", "please handle this");

      expect(enterCount(t.calls)).toBe(2);
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );

  test(
    "stops after MAX_SUBMIT_ATTEMPTS and warns when the pane never clears",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [PROMPT_PENDING]; // repeats → never clears

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      try {
        await t.sendText("sess:win", "stuck task");
      } finally {
        console.warn = origWarn;
      }

      // capped — not an unbounded spin
      expect(enterCount(t.calls)).toBe(4);
      expect(warnings.some(w => w.includes("pending input") && w.includes("sess:win"))).toBe(true);
    },
    15_000,
  );

  test(
    "multiline content routes through loadBuffer + pasteBuffer, then confirmed submit",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [PROMPT_IDLE];
      await t.sendText("sess:win", "line one\nline two");

      expect(t.calls[0]).toBe(`loadBuffer:${"line one\nline two".length}`);
      expect(t.calls[1]).toBe("pasteBuffer");
      expect(t.calls).not.toContain("sendKeysLiteral:line one\nline two");
      expect(enterCount(t.calls)).toBe(1);
    },
    10_000,
  );

  test(
    "a capture failure is treated as submitted — the retry loop cannot spin",
    async () => {
      const t = new FakeTmux();
      // capture throws → paneInputPending swallows → false (assume submitted)
      t.capture = async () => { throw new Error("tmux gone"); };
      await t.sendText("sess:win", "hi");

      expect(enterCount(t.calls)).toBe(1);
    },
    10_000,
  );

  // Claude Code panes (esp. with a custom statusline) draw the input box, then
  // several rows below it — a separator, model/context HUD rows, the "accept
  // edits" footer, sometimes a stray artifact. The un-submitted message is then
  // NOT the last line, so the old last-line check missed it and stopped after a
  // single Enter. paneInputPending now inspects the input box region.
  const TUI_STUCK = [
    "  earlier assistant reply …",
    "────────────────────────────",
    "❯ run the deploy",              // input line, message still pending
    "────────────────────────────",
    "  Model: Sonnet 5 | 5h:18%",
    "  ctx:26%/1M | ↑260",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
    "                        /rc",
  ].join("\n");
  const TUI_CLEARED = [
    "  earlier assistant reply …",
    "❯ run the deploy",              // moved into the transcript (submitted)
    "────────────────────────────",
    "❯ ",                            // input line empty
    "────────────────────────────",
    "  Model: Sonnet 5 | 5h:18%",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ].join("\n");

  test(
    "retries Enter for a message stuck above a Claude TUI HUD/footer",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [TUI_STUCK, TUI_CLEARED];
      await t.sendText("sess:win", "run the deploy");

      // pre-fix: last line was the "/rc" footer artifact → 1 blind Enter, no
      // retry. Now the stuck input line above the HUD is seen → one retry.
      expect(enterCount(t.calls)).toBe(2);
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );
});

describe("inputBoxRegion", () => {
  test("anchors at the prompt line even with a HUD/footer drawn below it", () => {
    const region = inputBoxRegion(
      [
        "  transcript line with the word deploy in it", // above prompt — excluded
        "────────────",
        "❯ deploy now",
        "  Model: Sonnet 5",
        "  ⏵⏵ accept edits on",
        "                 /rc",
      ].join("\n"),
    );
    expect(region.startsWith("❯ deploy now")).toBe(true);
    expect(region.includes("deploy now")).toBe(true);
    // the transcript copy above the prompt must not be in the region
    expect(region.includes("transcript line")).toBe(false);
  });

  test("an empty prompt above a HUD yields a region with no pending text", () => {
    const region = inputBoxRegion(
      ["❯ submitted earlier", "────", "❯ ", "  Model: x", "  ⏵⏵ footer"].join("\n"),
    );
    expect(region.split("\n")[0]).toBe("❯ ");
    expect(region.includes("submitted earlier")).toBe(false);
  });

  test("falls back to the last 3 non-empty lines when no prompt marker exists", () => {
    const region = inputBoxRegion(["a", "b", "c", "d", "e"].join("\n"));
    expect(region).toBe("c\nd\ne");
  });
});
