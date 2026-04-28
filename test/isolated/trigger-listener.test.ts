/**
 * Tests for setupTriggerListener from src/core/runtime/trigger-listener.ts.
 * Mocks trigger engine to test feed event → trigger mapping.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { FeedEvent } from "../../src/lib/feed";

const tmp = mkdtempSync(join(tmpdir(), "trigger-listener-"));

const firedEvents: { on: string; ctx: any }[] = [];
const activeAgents: string[] = [];

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "test",
    ghqRoot: tmp,
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: () => "",
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/core/runtime/triggers", () => ({
  fire: (on: string, ctx: any) => { firedEvents.push({ on, ctx }); },
  markAgentActive: (agent: string) => { activeAgents.push(agent); },
  checkIdleTriggers: () => {},
  getTriggers: () => [], // no idle triggers → no setInterval
}));

const { setupTriggerListener } = await import("../../src/core/runtime/trigger-listener");

beforeEach(() => {
  firedEvents.length = 0;
  activeAgents.length = 0;
});

function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    timestamp: new Date().toISOString(),
    oracle: "neo",
    host: "local",
    event: "Notification",
    project: "test",
    sessionId: "",
    message: "test",
    ts: Date.now(),
    ...overrides,
  };
}

describe("setupTriggerListener", () => {
  it("adds a listener to the set", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    expect(listeners.size).toBe(1);
  });

  it("marks agent active on any event", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    const listener = [...listeners][0];

    listener(makeFeedEvent({ oracle: "neo" }));
    expect(activeAgents).toContain("neo");
  });

  it("fires agent-wake on SessionStart event", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    const listener = [...listeners][0];

    listener(makeFeedEvent({ event: "SessionStart", oracle: "pulse" }));
    expect(firedEvents.some(e => e.on === "agent-wake" && e.ctx.agent === "pulse")).toBe(true);
  });

  it("fires agent-crash when Notification contains crash", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    const listener = [...listeners][0];

    listener(makeFeedEvent({ event: "Notification", oracle: "neo", message: "agent crashed unexpectedly" }));
    expect(firedEvents.some(e => e.on === "agent-crash" && e.ctx.agent === "neo")).toBe(true);
  });

  it("does not fire agent-crash for non-crash notifications", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    const listener = [...listeners][0];

    listener(makeFeedEvent({ event: "Notification", message: "task completed successfully" }));
    expect(firedEvents.filter(e => e.on === "agent-crash")).toHaveLength(0);
  });

  it("does not fire triggers for unknown event types", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    const listener = [...listeners][0];

    listener(makeFeedEvent({ event: "CustomEvent" }));
    // Should only mark active, not fire any triggers
    expect(firedEvents).toHaveLength(0);
    expect(activeAgents).toHaveLength(1);
  });

  it("crash detection is case-insensitive", () => {
    const listeners = new Set<(e: FeedEvent) => void>();
    setupTriggerListener(listeners);
    const listener = [...listeners][0];

    listener(makeFeedEvent({ event: "Notification", oracle: "neo", message: "CRASH detected" }));
    expect(firedEvents.some(e => e.on === "agent-crash")).toBe(true);
  });
});
