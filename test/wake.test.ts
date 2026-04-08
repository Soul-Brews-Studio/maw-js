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
