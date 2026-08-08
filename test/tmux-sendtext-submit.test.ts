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
  async exitModeIfNeeded(_target: string): Promise<boolean> {
    return false;
  }
}

const PROMPT_IDLE = "agent@host:~$ "; // prompt marker + trailing space → submitted
const PROMPT_PENDING = "agent@host:~$ unsent command text"; // input still on the line
const enterCount = (calls: string[]) => calls.filter(c => c === "sendKeys:Enter").length;
const cmCount = (calls: string[]) => calls.filter(c => c === "sendKeys:C-m").length;

// Full-screen TUI captures: the input line sits ABOVE a footer/status line, so
// lines.at(-1) is the footer, never the input. Mirrors real captures in the
// stall-fix evidence (T1-root-cause-at-object / T5-real-codex-pane-probe).
const CC_PENDING = [
  "✻ Churned for 20s",
  "────────────────────────────────────",
  "❯ commit the ψ brain writes", // real un-submitted input, marker at line-start
  "────────────────────────────────────",
  "   🐾 Opus 4.8  █░░░░░░░░░ 6% ctx 57k/1000k  ~/ghq/github.com/sutthikit/akita-oracle",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent", // footer = bottom line
].join("\n");
const CC_SUBMITTED_ECHO = [
  "> commit the ψ brain writes", // submitted turn echoed into the conversation area
  "✻ Churned for 2s",
  "❯ ", // input line now empty — must read as submitted despite the echo above
  "   🐾 Opus 4.8  █░░░░░░░░░ 6% ctx 57k/1000k  ~/ghq/github.com/sutthikit/akita-oracle",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
].join("\n");
const CODEX_PLACEHOLDER = [
  "─ Worked for 4m 03s ──────────────────────",
  "› Use /skills to list available skills", // empty-state ghost, NOT real input
  "  gpt-5.6-sol xhigh · pharaoh-oracle-horo · Context 47% left · 26.3M in · 317K out",
].join("\n");
const MENU_DIALOG = [
  "Do you want to proceed?",
  "❯ 1. Yes", // selection cursor + option — must NOT loop Enter into an auto-approve
  "  2. No",
].join("\n");

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

      // capped — not an unbounded spin. Final attempt escalates the named
      // `Enter` to a literal `C-m` (Enter-eaten last-ditch): 3 Enter + 1 C-m.
      expect(enterCount(t.calls)).toBe(3);
      expect(cmCount(t.calls)).toBe(1);
      // condition #3: every C-m escalation is logged (append-only audit).
      expect(warnings.some(w => w.includes("escalating to literal C-m") && w.includes("sess:win"))).toBe(true);
      expect(warnings.some(w => w.includes("pending input") && w.includes("sess:win"))).toBe(true);
    },
    15_000,
  );

  test(
    "TUI (Claude Code): reads the ❯ input line ABOVE the footer, not lines.at(-1) — retries the eaten Enter",
    async () => {
      const t = new FakeTmux();
      // pending (footer is the bottom line, input is above it) then cleared
      t.captureScript = [CC_PENDING, PROMPT_IDLE];
      await t.sendText("sess:cc", "commit the ψ brain writes");

      // The old lines.at(-1)-only probe read the '⏵⏵ …' footer → saw no pending
      // input → stopped at 1 Enter (the silent stall). The scan retries.
      expect(enterCount(t.calls)).toBe(2);
    },
    15_000,
  );

  test(
    "TUI (Claude Code): a submitted turn echoed into the conversation area is NOT read as pending",
    async () => {
      const t = new FakeTmux();
      // input line is empty ('❯ ') but the sent text still shows in scrollback
      // above. Scoping the sent-text check to the input line prevents an endless
      // retry / duplicate submit on that echo.
      t.captureScript = [CC_SUBMITTED_ECHO];
      await t.sendText("sess:cc", "commit the ψ brain writes");

      expect(enterCount(t.calls)).toBe(1); // submitted on first check, no spin
      expect(cmCount(t.calls)).toBe(0);
    },
    10_000,
  );

  test(
    "TUI (Codex): empty-state placeholder '› Use /skills…' is NOT pending — no false retry (condition #2)",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [CODEX_PLACEHOLDER]; // repeats → a misread would spin to the cap
      await t.sendText("sess:codex", "x");

      expect(enterCount(t.calls)).toBe(1);
      expect(cmCount(t.calls)).toBe(0);
    },
    10_000,
  );

  test(
    "menu/dialog cursor '❯ 1. Yes' is NOT read as pending — never loops Enter into an auto-approve (Collie CRIT-1)",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [MENU_DIALOG]; // if the option were read as pending, Enter would auto-select

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      try {
        await t.sendText("sess:menu", "some dispatch");
      } finally {
        console.warn = origWarn;
      }

      expect(enterCount(t.calls)).toBe(1); // treated as submitted → stops, no C-m
      expect(cmCount(t.calls)).toBe(0);
      expect(warnings.length).toBe(0);
    },
    10_000,
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
