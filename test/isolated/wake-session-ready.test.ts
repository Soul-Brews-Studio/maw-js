import { describe, expect, test } from "bun:test";
import {
  retryFreshSessionTmuxStep,
  waitForTmuxSessionReady,
} from "../../src/commands/shared/wake-cmd";

describe("fresh wake tmux session readiness (#1440)", () => {
  test("waitForTmuxSessionReady waits until tmux can see the new session", async () => {
    let checks = 0;
    const sleeps: number[] = [];

    await waitForTmuxSessionReady("47-mawjs", {
      attempts: 4,
      delayMs: 5,
      sleep: async ms => { sleeps.push(ms); },
      hasSession: async session => {
        expect(session).toBe("47-mawjs");
        checks++;
        return checks === 3;
      },
    });

    expect(checks).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  test("waitForTmuxSessionReady is best-effort when external tmux visibility lags", async () => {
    const sleeps: number[] = [];

    await waitForTmuxSessionReady("63-calliope-oracle", {
      attempts: 2,
      delayMs: 5,
      sleep: async ms => { sleeps.push(ms); },
      hasSession: async () => false,
    });

    expect(sleeps).toEqual([5]);
  });

  test("retryFreshSessionTmuxStep retries transient can't-find-session startup races", async () => {
    let attempts = 0;
    const result = await retryFreshSessionTmuxStep("47-mawjs", "launch main window", async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("[local:local] can't find session: 47-mawjs");
      }
      return "launched";
    }, {
      attempts: 3,
      delayMs: 5,
      sleep: async () => {},
    });

    expect(result).toBe("launched");
    expect(attempts).toBe(2);
  });

  test("retryFreshSessionTmuxStep ignores stale external session probes while retrying the real step", async () => {
    let attempts = 0;
    const result = await retryFreshSessionTmuxStep("63-calliope-oracle", "launch main window", async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("[local:local] can't find session: 63-calliope-oracle");
      }
      return "launched";
    }, {
      attempts: 3,
      delayMs: 5,
      sleep: async () => {},
      hasSession: async () => { throw new Error("stale readiness probe should not gate retry"); },
    });

    expect(result).toBe("launched");
    expect(attempts).toBe(2);
  });

  test("retryFreshSessionTmuxStep does not hide unrelated setup failures", async () => {
    let attempts = 0;

    await expect(retryFreshSessionTmuxStep("47-mawjs", "set session environment", async () => {
      attempts++;
      throw new Error("pass show 'secret' failed (exit 1)");
    }, {
      attempts: 3,
      sleep: async () => {},
      hasSession: async () => true,
    })).rejects.toThrow(/pass show/);

    expect(attempts).toBe(1);
  });
});
