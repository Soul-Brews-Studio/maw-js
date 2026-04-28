/**
 * Tests for handleCrashedAgents from src/engine/engine-crash.ts.
 * Mocks tmux, config, and ssh to test the auto-restart logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "engine-crash-"));

let autoRestart = true;
const sentTexts: { target: string; cmd: string }[] = [];

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
    autoRestart,
    node: "test-node",
    ghqRoot: tmp,
    agents: { "neo-oracle": { cmd: "echo neo" } },
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: (name: string) => `run-${name}`,
  buildCommandInDir: (n: string, d: string) => `run-${n}-in-${d}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    sendText: async (target: string, cmd: string) => {
      sentTexts.push({ target, cmd });
    },
    ls: async () => [],
    kill: async () => {},
    newWindow: async () => {},
    newSession: async () => {},
    hasSession: async () => false,
    splitWindow: async () => {},
  },
}));

mock.module("../../src/core/transport/ssh", () => ({
  listSessions: async () => [],
  hostExec: async () => "",
  sendKeys: async () => {},
  selectWindow: async () => {},
  capture: async () => "",
  getPaneCommand: async () => "",
  getPaneInfos: async () => ({}),
}));

const { handleCrashedAgents } = await import("../../src/engine/engine-crash");

// Minimal StatusDetector mock
function makeStatusDetector(crashedAgents: { target: string; name: string; session: string }[]) {
  const clearedTargets: string[] = [];
  return {
    getCrashedAgents: () => crashedAgents,
    clearCrashed: (target: string) => { clearedTargets.push(target); },
    clearedTargets,
  };
}

type FeedEvent = { timestamp: string; oracle: string; host: string; event: string; project: string; sessionId: string; message: string; ts: number };

beforeEach(() => {
  sentTexts.length = 0;
  autoRestart = true;
});

describe("handleCrashedAgents", () => {
  it("does nothing when autoRestart is disabled", async () => {
    autoRestart = false;
    const status = makeStatusDetector([
      { target: "proj:0", name: "neo-oracle", session: "proj" },
    ]);
    const clients = new Set<any>();
    const feedListeners = new Set<(e: FeedEvent) => void>();

    await handleCrashedAgents(status as any, [], clients, feedListeners);
    expect(sentTexts).toHaveLength(0);
  });

  it("restarts crashed agents", async () => {
    const status = makeStatusDetector([
      { target: "proj:0", name: "neo-oracle", session: "proj" },
    ]);
    const sessions = [{ name: "proj", windows: [{ index: 0, name: "neo-oracle", active: true }] }];
    const clients = new Set<any>();
    const feedListeners = new Set<(e: FeedEvent) => void>();

    await handleCrashedAgents(status as any, sessions, clients, feedListeners);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0].target).toBe("proj:0");
    expect(sentTexts[0].cmd).toBe("run-neo-oracle");
  });

  it("clears crashed state after restart", async () => {
    const status = makeStatusDetector([
      { target: "proj:0", name: "neo-oracle", session: "proj" },
    ]);
    const clients = new Set<any>();
    const feedListeners = new Set<(e: FeedEvent) => void>();

    await handleCrashedAgents(status as any, [], clients, feedListeners);
    expect(status.clearedTargets).toContain("proj:0");
  });

  it("broadcasts feed event to WebSocket clients", async () => {
    const status = makeStatusDetector([
      { target: "proj:0", name: "neo-oracle", session: "proj" },
    ]);
    const sentMessages: string[] = [];
    const fakeClient = { send: (msg: string) => sentMessages.push(msg) };
    const clients = new Set<any>([fakeClient]);
    const feedListeners = new Set<(e: FeedEvent) => void>();

    await handleCrashedAgents(status as any, [], clients, feedListeners);
    expect(sentMessages).toHaveLength(1);
    const parsed = JSON.parse(sentMessages[0]);
    expect(parsed.type).toBe("feed");
    expect(parsed.event.event).toBe("SubagentStart");
    expect(parsed.event.message).toContain("auto-restarted");
  });

  it("fires feed listeners", async () => {
    const status = makeStatusDetector([
      { target: "proj:0", name: "neo-oracle", session: "proj" },
    ]);
    const clients = new Set<any>();
    const firedEvents: FeedEvent[] = [];
    const feedListeners = new Set<(e: FeedEvent) => void>([
      (e) => firedEvents.push(e),
    ]);

    await handleCrashedAgents(status as any, [], clients, feedListeners);
    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0].oracle).toBe("neo");
    expect(firedEvents[0].event).toBe("SubagentStart");
  });

  it("strips -oracle suffix from agent name in feed event", async () => {
    const status = makeStatusDetector([
      { target: "proj:0", name: "pulse-oracle", session: "proj" },
    ]);
    const firedEvents: FeedEvent[] = [];
    const feedListeners = new Set<(e: FeedEvent) => void>([
      (e) => firedEvents.push(e),
    ]);

    await handleCrashedAgents(status as any, [], new Set(), feedListeners);
    expect(firedEvents[0].oracle).toBe("pulse");
  });

  it("restarts multiple crashed agents", async () => {
    const status = makeStatusDetector([
      { target: "proj:0", name: "neo-oracle", session: "proj" },
      { target: "proj:1", name: "pulse-oracle", session: "proj" },
    ]);
    const clients = new Set<any>();
    const feedListeners = new Set<(e: FeedEvent) => void>();

    await handleCrashedAgents(status as any, [], clients, feedListeners);
    expect(sentTexts).toHaveLength(2);
    expect(status.clearedTargets).toHaveLength(2);
  });

  it("does nothing when no agents are crashed", async () => {
    const status = makeStatusDetector([]);
    const clients = new Set<any>();
    const feedListeners = new Set<(e: FeedEvent) => void>();

    await handleCrashedAgents(status as any, [], clients, feedListeners);
    expect(sentTexts).toHaveLength(0);
  });

  it("sets session name as project in feed event", async () => {
    const status = makeStatusDetector([
      { target: "my-project:0", name: "neo-oracle", session: "my-project" },
    ]);
    const firedEvents: FeedEvent[] = [];
    const feedListeners = new Set<(e: FeedEvent) => void>([
      (e) => firedEvents.push(e),
    ]);

    await handleCrashedAgents(status as any, [], new Set(), feedListeners);
    expect(firedEvents[0].project).toBe("my-project");
  });
});
