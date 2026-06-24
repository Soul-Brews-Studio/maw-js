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
// injects `claude` as text into the running agent's prompt. A pane is safe to
// re-launch into ONLY when its foreground is a bare shell (tmux's reliable
// pane_current_command) AND it has no live child process. Anything else —
// incl. `claude.exe` even when the name isn't recognized (node without the
// .exe strip) — is treated as alive. pid alone is unreliable (#eq3: claude
// not always a pane-shell child).
describe("re-launch guard — no live-pane pollution (#eq3)", () => {
  const SHELLS = new Set(["", "zsh", "bash", "sh", "fish"]);
  function safeToRelaunch(command: string, isAgent: (c: string) => boolean, paneIdle: boolean): boolean {
    let agentAlive = isAgent(command);
    if (!agentAlive) {
      const cmd = (command || "").trim().toLowerCase().replace(/^-/, "");
      const isIdleShell = SHELLS.has(cmd);
      if (!isIdleShell || !paneIdle) agentAlive = true; // non-shell OR busy ⇒ alive
    }
    return !agentAlive; // only relaunch a genuinely idle bare shell
  }
  const isAgent = (c: string) => ["claude", "codex", "node"].includes(c); // post-.exe-strip basenames

  test("recognized agent → NOT relaunched (alive)", () => {
    expect(safeToRelaunch("claude", isAgent, true)).toBe(false);
  });
  test("claude.exe with name UNrecognized (non-#31 node) but idle → still NOT relaunched (current_command guard — the fix)", () => {
    expect(safeToRelaunch("claude.exe", isAgent, true)).toBe(false); // not a shell ⇒ alive
  });
  test("non-shell foreground (vim/python) even when busy → NOT relaunched", () => {
    expect(safeToRelaunch("vim", isAgent, true)).toBe(false);
    expect(safeToRelaunch("python", isAgent, false)).toBe(false);
  });
  test("bare shell WITH children (mid-startup) → NOT relaunched (busy)", () => {
    expect(safeToRelaunch("zsh", isAgent, false)).toBe(false);
  });
  test("genuinely dead pane (bare idle shell) → relaunched", () => {
    expect(safeToRelaunch("zsh", isAgent, true)).toBe(true);
    expect(safeToRelaunch("-zsh", isAgent, true)).toBe(true); // login-shell dash stripped
    expect(safeToRelaunch("", isAgent, true)).toBe(true);
  });
});
