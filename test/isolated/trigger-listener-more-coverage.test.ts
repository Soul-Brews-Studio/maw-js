import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedEvent } from "../../src/lib/feed";

type Trigger = { on: string; action?: string };

type FireCall = { event: string; ctx: Record<string, unknown> };

let triggers: Trigger[] = [];
let fireCalls: FireCall[] = [];
let activeAgents: string[] = [];
let idleChecks = 0;

mock.module(import.meta.resolve("../../src/core/runtime/triggers.ts"), () => ({
  fire: (event: string, ctx: Record<string, unknown>) => {
    fireCalls.push({ event, ctx });
  },
  markAgentActive: (agent: string) => {
    activeAgents.push(agent);
  },
  checkIdleTriggers: () => {
    idleChecks += 1;
  },
  getTriggers: () => triggers,
}));

const { setupTriggerListener } = await import("../../src/core/runtime/trigger-listener.ts?trigger-listener-more-coverage");

const originalSetInterval = globalThis.setInterval;
let intervalCalls: Array<{ callback: () => void; delay: number }> = [];

function feed(event: Partial<FeedEvent>): FeedEvent {
  return event as FeedEvent;
}

beforeEach(() => {
  triggers = [];
  fireCalls = [];
  activeAgents = [];
  idleChecks = 0;
  intervalCalls = [];
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    intervalCalls.push({ callback, delay: delay ?? 0 });
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
});

describe("setupTriggerListener", () => {
  test("registers a listener without scheduling idle checks when no idle triggers are configured", () => {
    const listeners = new Set<(event: FeedEvent) => void>();

    setupTriggerListener(listeners);

    expect(listeners.size).toBe(1);
    expect(intervalCalls).toEqual([]);

    const [listener] = listeners;
    listener(feed({ event: "Message" }));

    expect(activeAgents).toEqual([]);
    expect(fireCalls).toEqual([]);
    expect(idleChecks).toBe(0);
  });

  test("marks agent activity and maps SessionStart to agent-wake", () => {
    const listeners = new Set<(event: FeedEvent) => void>();
    setupTriggerListener(listeners);

    const [listener] = listeners;
    listener(feed({ event: "SessionStart", oracle: "oracle-alpha" }));

    expect(activeAgents).toEqual(["oracle-alpha"]);
    expect(fireCalls).toEqual([
      { event: "agent-wake", ctx: { agent: "oracle-alpha" } },
    ]);
  });

  test("maps crash notifications case-insensitively and ignores non-crash notifications", () => {
    const listeners = new Set<(event: FeedEvent) => void>();
    setupTriggerListener(listeners);

    const [listener] = listeners;
    listener(feed({ event: "Notification", oracle: "oracle-beta", message: "Agent CRASH detected" }));
    listener(feed({ event: "Notification", oracle: "oracle-beta", message: "Agent completed normally" }));

    expect(activeAgents).toEqual(["oracle-beta", "oracle-beta"]);
    expect(fireCalls).toEqual([
      { event: "agent-crash", ctx: { agent: "oracle-beta" } },
    ]);
  });

  test("schedules the idle trigger poll only when an agent-idle trigger exists", () => {
    triggers = [
      { on: "agent-wake", action: "echo wake" },
      { on: "agent-idle", action: "echo idle" },
    ];
    const listeners = new Set<(event: FeedEvent) => void>();

    setupTriggerListener(listeners);

    expect(intervalCalls).toHaveLength(1);
    expect(intervalCalls[0]?.delay).toBe(15_000);

    intervalCalls[0]?.callback();

    expect(idleChecks).toBe(1);
  });
});
