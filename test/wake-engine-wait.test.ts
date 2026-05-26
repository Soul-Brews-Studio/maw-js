import { describe, test, expect } from "bun:test";

/**
 * Tests for waitForEngine logic — the core of the #1906 race-condition fix.
 *
 * We replicate the waitForEngine logic inline with injectable dependencies
 * (same pattern as wake.test.ts / isPaneIdleWith) to avoid mock.module()
 * process-global leakage.
 *
 * Scenario being guarded: maw wake with a non-claude engine (e.g. thclaws):
 *   1. newSession() + sendText('thclaws --cli')   ← pane still shows 'zsh'
 *   2. liveness check: getPaneInfos → 'zsh' → isAgentCommand=false → re-sends ← BUG
 * waitForEngine() sits between step 1 and 2, blocking until the pane command
 * flips to the engine binary.
 */

// --- Inline replication of waitForEngine (keep in sync with wake-session.ts) ---

async function waitForEngineWith(
  paneTarget: string,
  getPaneInfos: (targets: string[]) => Promise<Record<string, { command: string }>>,
  isAgentCommand: (cmd: string | null | undefined) => boolean,
  timeoutMs = 5000,
  pollIntervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const infos = await getPaneInfos([paneTarget]);
      const info = infos[paneTarget];
      if (info && isAgentCommand(info.command)) return true;
    } catch { /* tolerate transient tmux errors */ }
    if (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }
  return false;
}

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
    const getPaneInfos = makeGetPaneInfos(["thclaws"]);
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 500, 50);
    expect(result).toBe(true);
  });

  test("engine starts after a few polls → returns true", async () => {
    // First 2 polls return 'zsh', third returns 'thclaws'
    const getPaneInfos = makeGetPaneInfos(["zsh", "zsh", "thclaws"]);
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 1000, 50);
    expect(result).toBe(true);
  });

  test("engine never starts → returns false on timeout", async () => {
    const getPaneInfos = makeGetPaneInfos(["zsh"]);
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 150, 50);
    expect(result).toBe(false);
  });

  test("getPaneInfos throws → keeps polling, returns false on timeout", async () => {
    let calls = 0;
    const getPaneInfos = async (_targets: string[]) => {
      calls++;
      throw new Error("tmux not ready");
    };
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 150, 50);
    expect(result).toBe(false);
    expect(calls).toBeGreaterThan(1); // polled multiple times despite errors
  });

  test("pane not in result → continues polling", async () => {
    let call = 0;
    const getPaneInfos = async (targets: string[]) => {
      // First call: pane missing from result; second call: pane present with engine
      if (call++ === 0) return {} as Record<string, { command: string }>;
      return Object.fromEntries(targets.map(t => [t, { command: "claude" }]));
    };
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 500, 50);
    expect(result).toBe(true);
  });

  test("versioned claude binary (2.1.121) recognised as agent", async () => {
    const getPaneInfos = makeGetPaneInfos(["2.1.121"]);
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 500, 50);
    expect(result).toBe(true);
  });

  test("shell commands are never recognised as agents", async () => {
    for (const shell of ["zsh", "bash", "sh", ""]) {
      const getPaneInfos = makeGetPaneInfos([shell]);
      const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 100, 40);
      expect(result).toBe(false);
    }
  });

  test("multiple pane targets — correct pane is checked", async () => {
    const getPaneInfos = async (targets: string[]) => {
      // Only "sess:oracle" has the engine; others have zsh
      return Object.fromEntries(targets.map(t => [
        t,
        { command: t === "sess:oracle" ? "thclaws" : "zsh" },
      ]));
    };
    const result = await waitForEngineWith("sess:oracle", getPaneInfos, isAgent, 500, 50);
    expect(result).toBe(true);
  });
});
