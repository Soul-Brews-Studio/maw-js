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
import { Tmux } from "../src/core/transport/tmux-class";

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
});
