import { describe, test, expect } from "bun:test";
import { waitForEngine } from "../src/commands/shared/wake-session";

/**
 * Tests for waitForEngine — the core of the #1906 race-condition fix.
 *
 * waitForEngine() accepts getPaneInfos and isAgentCommand as parameters so
 * tests can pass controlled doubles without mock.module() process-global
 * leakage. We import the real function and exercise it through its public
 * interface.
 *
 * Scenario being guarded: maw wake with a non-claude engine (e.g. thclaws):
 *   1. newSession() + sendText('thclaws --cli')   ← pane still shows 'zsh'
 *   2. liveness check: getPaneInfos → 'zsh' → isAgentCommand=false → re-sends ← BUG
 * waitForEngine() sits between step 1 and 2, blocking until the pane command
 * flips to the engine binary.
 */

// --- Helpers ---

const isAgent = (cmd: string | null | undefined) => {
  const c = (cmd ?? "").trim();
  return /claude|codex|node|thclaws/i.test(c) || /^\d+\.\d+\.\d+$/.test(c);
};

function makeGetPaneInfos(sequence: string[]): (targets: string[]) => Promise<Record<string, { command: string }>> {
  let call = 0;
  return async (targets: string[]) => {
    const cmd = sequence[Math.min(call++, sequence.length - 1)];
    return Object.fromEntries(targets.map(t => [t, { command: cmd }]));
  };
}

// --- Tests ---

describe("waitForEngine (#1906 race condition fix)", () => {
  test("engine already running → returns true on first poll", async () => {
    const result = await waitForEngine("sess:oracle", makeGetPaneInfos(["thclaws"]), isAgent, 500, 50);
    expect(result).toBe(true);
  });

  test("engine starts after a few polls → returns true", async () => {
    // First 2 polls return 'zsh', third returns 'thclaws'
    const result = await waitForEngine("sess:oracle", makeGetPaneInfos(["zsh", "zsh", "thclaws"]), isAgent, 1000, 50);
    expect(result).toBe(true);
  });

  test("engine never starts → returns false on timeout", async () => {
    const result = await waitForEngine("sess:oracle", makeGetPaneInfos(["zsh"]), isAgent, 150, 50);
    expect(result).toBe(false);
  });

  test("getPaneInfos throws → keeps polling, returns false on timeout", async () => {
    let calls = 0;
    const getPaneInfos = async (_targets: string[]) => {
      calls++;
      throw new Error("tmux not ready");
    };
    const result = await waitForEngine("sess:oracle", getPaneInfos, isAgent, 150, 50);
    expect(result).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });

  test("pane not in result → continues polling", async () => {
    let call = 0;
    const getPaneInfos = async (targets: string[]) => {
      if (call++ === 0) return {} as Record<string, { command: string }>;
      return Object.fromEntries(targets.map(t => [t, { command: "claude" }]));
    };
    const result = await waitForEngine("sess:oracle", getPaneInfos, isAgent, 500, 50);
    expect(result).toBe(true);
  });

  test("versioned claude binary (2.1.121) recognised as agent", async () => {
    const result = await waitForEngine("sess:oracle", makeGetPaneInfos(["2.1.121"]), isAgent, 500, 50);
    expect(result).toBe(true);
  });

  test("shell commands are never recognised as agents", async () => {
    for (const shell of ["zsh", "bash", "sh", ""]) {
      const result = await waitForEngine("sess:oracle", makeGetPaneInfos([shell]), isAgent, 100, 40);
      expect(result).toBe(false);
    }
  });

  test("multiple pane targets — correct pane is checked", async () => {
    const getPaneInfos = async (targets: string[]) =>
      Object.fromEntries(targets.map(t => [t, { command: t === "sess:oracle" ? "thclaws" : "zsh" }]));
    const result = await waitForEngine("sess:oracle", getPaneInfos, isAgent, 500, 50);
    expect(result).toBe(true);
  });
});
