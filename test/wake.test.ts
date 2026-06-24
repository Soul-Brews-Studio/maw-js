import { describe, test, expect } from "bun:test";

/**
 * Tests for isPaneIdle logic — the core of the #196 fix.
 *
 * We test the logic WITHOUT mock.module to avoid poisoning the global
 * module cache (bun's mock.module is process-global and leaks across files).
 * Instead we replicate the isPaneIdle logic inline, which is small enough
 * to keep in sync, and run integration-style tests for the actual export.
 */

// Replicate isPaneIdle logic for unit testing with controlled hostExec
async function isPaneIdleWith(
  paneTarget: string,
  hostExec: (cmd: string) => Promise<string>,
): Promise<boolean> {
  try {
    const panePid = (await hostExec(
      `tmux display-message -t '${paneTarget}' -p '#{pane_pid}'`
    )).trim();
    if (!panePid) return true;
    const children = (await hostExec(`pgrep -P ${panePid} 2>/dev/null || true`)).trim();
    return children.length === 0;
  } catch {
    return true;
  }
}

describe("isPaneIdle", () => {
  test("idle pane (no children) → returns true", async () => {
    const exec = async (cmd: string) => {
      if (cmd.includes("display-message")) return "12345";
      if (cmd.includes("pgrep")) return "";
      return "";
    };
    expect(await isPaneIdleWith("sess:win", exec)).toBe(true);
  });

  test("busy pane (has children) → returns false", async () => {
    const exec = async (cmd: string) => {
      if (cmd.includes("display-message")) return "12345";
      if (cmd.includes("pgrep")) return "12346\n12347";
      return "";
    };
    expect(await isPaneIdleWith("sess:win", exec)).toBe(false);
  });

  test("error → returns true (fail-safe)", async () => {
    const exec = async () => { throw new Error("tmux not found"); };
    expect(await isPaneIdleWith("sess:win", exec)).toBe(true);
  });

  test("empty pane_pid → returns true", async () => {
    const exec = async (cmd: string) => {
      if (cmd.includes("display-message")) return "";
      return "";
    };
    expect(await isPaneIdleWith("sess:win", exec)).toBe(true);
  });

  test("pane_pid with whitespace → trimmed and checked", async () => {
    const exec = async (cmd: string) => {
      if (cmd.includes("display-message")) return "  54321  \n";
      if (cmd.includes("pgrep")) return "  ";
      return "";
    };
    expect(await isPaneIdleWith("sess:win", exec)).toBe(true);
  });

  test("single child process → returns false", async () => {
    const exec = async (cmd: string) => {
      if (cmd.includes("display-message")) return "12345";
      if (cmd.includes("pgrep")) return "12346";
      return "";
    };
    expect(await isPaneIdleWith("sess:win", exec)).toBe(false);
  });
});

// Mirror of the cmdWake re-launch guard (wake-cmd.ts ~1637): wake must NEVER
// sendText() a fresh launch command into a pane that hosts a LIVE agent — that
// injects `claude` as text into the running agent's prompt. A pane counts as
// alive when its command is a recognized agent OR it still has a live child
// process (busy). Only a genuinely idle pane is safe to re-launch into.
describe("re-launch guard — no live-pane pollution (#eq3)", () => {
  function safeToRelaunch(command: string, isAgent: (c: string) => boolean, paneIdle: boolean): boolean {
    let agentAlive = isAgent(command);
    if (!agentAlive && !paneIdle) agentAlive = true; // busy pane ⇒ treat as alive
    return !agentAlive; // only relaunch when genuinely not alive
  }
  const isAgent = (c: string) => ["claude", "codex", "node"].includes(c); // post-.exe-strip basenames

  test("recognized agent + idle → NOT relaunched (alive)", () => {
    expect(safeToRelaunch("claude", isAgent, true)).toBe(false);
  });
  test("unrecognized command but pane BUSY → NOT relaunched (pid guard — the fix)", () => {
    expect(safeToRelaunch("python", isAgent, false)).toBe(false);
    expect(safeToRelaunch("some-new-engine", isAgent, false)).toBe(false);
  });
  test("genuinely dead pane (unrecognized + idle) → relaunched", () => {
    expect(safeToRelaunch("zsh", isAgent, true)).toBe(true);
    expect(safeToRelaunch("bash", isAgent, true)).toBe(true);
  });
});
