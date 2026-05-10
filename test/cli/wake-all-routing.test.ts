/**
 * Regression tests for `maw wake all` routing.
 *
 * Pre-#918 the wake/ plugin routed `maw wake all` to cmdWakeAll. When wake
 * moved to top-aliases via the direct-handler path (#979949d7 follow-on),
 * the early-route was lost — "all" started resolving as a literal oracle
 * name. This surfaced in production as the maw-boot regression on
 * 2026-05-06 (pulse-oracle inbox: 22:15 BKK ship report).
 *
 * Tests verify that invokeDirectHandler with positional "all" routes to
 * cmdWakeAll (not cmdWake) and forwards the three supported flags.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// Capture cmdWakeAll + cmdWake invocations without spawning real tmux sessions.
const wakeAllCalls: any[] = [];
const wakeCalls: any[] = [];

mock.module("../../src/commands/shared/fleet-wake", () => ({
  cmdWakeAll: async (opts: any) => { wakeAllCalls.push(opts); },
  cmdSleep: async () => {},
}));

mock.module("../../src/commands/shared/wake-cmd", () => ({
  cmdWake: async (oracle: string, opts: any) => { wakeCalls.push({ oracle, opts }); return ""; },
}));

const { invokeDirectHandler } = await import("../../src/cli/top-aliases");

const WAKE_HANDLER = "../commands/shared/wake-cmd:cmdWake";

describe("`maw wake all` routing → cmdWakeAll", () => {
  beforeEach(() => {
    wakeAllCalls.length = 0;
    wakeCalls.length = 0;
  });

  test("`wake all` routes to cmdWakeAll (not cmdWake)", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["all"]);
    expect(wakeAllCalls).toHaveLength(1);
    expect(wakeAllCalls[0]).toEqual({ kill: false, all: false, resume: false });
    expect(wakeCalls).toHaveLength(0);
  });

  test("`wake all --resume` forwards resume=true", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["all", "--resume"]);
    expect(wakeAllCalls).toHaveLength(1);
    expect(wakeAllCalls[0]).toEqual({ kill: false, all: false, resume: true });
    expect(wakeCalls).toHaveLength(0);
  });

  test("`wake all --kill` forwards kill=true", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["all", "--kill"]);
    expect(wakeAllCalls[0]).toEqual({ kill: true, all: false, resume: false });
  });

  test("`wake all --all` forwards all=true (include dormant 20+)", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["all", "--all"]);
    expect(wakeAllCalls[0]).toEqual({ kill: false, all: true, resume: false });
  });

  test("`wake all --kill --resume --all` forwards every flag", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["all", "--kill", "--resume", "--all"]);
    expect(wakeAllCalls[0]).toEqual({ kill: true, all: true, resume: true });
  });

  test("`wake ALL` (uppercase) still routes to cmdWakeAll", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["ALL"]);
    expect(wakeAllCalls).toHaveLength(1);
    expect(wakeCalls).toHaveLength(0);
  });

  test("`wake neo` does NOT route to cmdWakeAll (single-oracle path)", async () => {
    await invokeDirectHandler(WAKE_HANDLER, ["neo"]);
    expect(wakeAllCalls).toHaveLength(0);
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0].oracle).toBe("neo");
  });
});
