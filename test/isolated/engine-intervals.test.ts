/**
 * Tests for startIntervals / stopIntervals from src/engine/engine-intervals.ts.
 * Mocks all heavy dependencies to test interval lifecycle logic.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { EngineIntervalState } from "../../src/engine/engine-intervals";

const tmp = mkdtempSync(join(tmpdir(), "engine-int-"));

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
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: (n: string, d: string) => `echo ${n}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 60000, // long enough that they won't actually fire
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/engine/capture", () => ({
  pushCapture: () => {},
  pushPreviews: () => {},
  broadcastSessions: async () => [],
  sendBusyAgents: () => {},
}));

mock.module("../../src/engine/teams", () => ({
  broadcastTeams: () => {},
}));

mock.module("../../src/core/transport/peers", () => ({
  getAggregatedSessions: async () => [],
  getPeers: () => [],
}));

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    listAll: async () => [],
    sendText: async () => {},
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

const { startIntervals, stopIntervals } = await import(
  "../../src/engine/engine-intervals"
);

function makeState(): EngineIntervalState {
  return {
    clients: new Set(),
    lastContent: new Map(),
    lastPreviews: new Map(),
    sessionCache: { sessions: [], json: "[]" },
    peerSessionsCache: [],
    status: {
      detect: async () => {},
      getStatus: () => null,
      getCrashedAgents: () => [],
      clearCrashed: () => {},
      pruneState: () => {},
    } as any,
    lastTeamsJson: { value: "" },
    feedListeners: new Set(),
    feedBuffer: [],
    transportRouter: null,
    captureInterval: null,
    sessionInterval: null,
    previewInterval: null,
    statusInterval: null,
    teamsInterval: null,
    peerInterval: null,
    crashCheckInterval: null,
    feedUnsub: null,
  };
}

let activeState: EngineIntervalState | null = null;

afterEach(() => {
  if (activeState) {
    // Force clear all intervals
    activeState.clients.clear();
    stopIntervals(activeState);
    // Manually clear any remaining
    for (const key of ["captureInterval", "sessionInterval", "previewInterval", "statusInterval", "teamsInterval", "peerInterval", "crashCheckInterval"] as const) {
      if (activeState[key]) {
        clearInterval(activeState[key]!);
        activeState[key] = null;
      }
    }
    activeState = null;
  }
});

describe("startIntervals", () => {
  it("sets all interval handles", () => {
    const state = makeState();
    activeState = state;
    startIntervals(state, () => {});

    expect(state.captureInterval).not.toBeNull();
    expect(state.sessionInterval).not.toBeNull();
    expect(state.previewInterval).not.toBeNull();
    expect(state.statusInterval).not.toBeNull();
    expect(state.teamsInterval).not.toBeNull();
    expect(state.peerInterval).not.toBeNull();
    expect(state.crashCheckInterval).not.toBeNull();
  });

  it("is no-op when already running", () => {
    const state = makeState();
    activeState = state;
    startIntervals(state, () => {});
    const firstCapture = state.captureInterval;
    startIntervals(state, () => {});
    expect(state.captureInterval).toBe(firstCapture); // same handle
  });

  it("adds feed listener", () => {
    const state = makeState();
    activeState = state;
    const before = state.feedListeners.size;
    startIntervals(state, () => {});
    expect(state.feedListeners.size).toBe(before + 1);
  });

  it("sets feedUnsub", () => {
    const state = makeState();
    activeState = state;
    startIntervals(state, () => {});
    expect(state.feedUnsub).not.toBeNull();
  });
});

describe("stopIntervals", () => {
  it("clears all intervals when no clients remain", () => {
    const state = makeState();
    activeState = state;
    startIntervals(state, () => {});

    // No clients → should stop
    stopIntervals(state);

    expect(state.captureInterval).toBeNull();
    expect(state.sessionInterval).toBeNull();
    expect(state.previewInterval).toBeNull();
    expect(state.statusInterval).toBeNull();
    expect(state.teamsInterval).toBeNull();
    expect(state.peerInterval).toBeNull();
    expect(state.crashCheckInterval).toBeNull();
  });

  it("does not clear intervals when clients remain", () => {
    const state = makeState();
    activeState = state;
    state.clients.add({ send: () => {} } as any);
    startIntervals(state, () => {});

    stopIntervals(state);

    expect(state.captureInterval).not.toBeNull();
  });

  it("removes feed listener via feedUnsub", () => {
    const state = makeState();
    activeState = state;
    startIntervals(state, () => {});
    expect(state.feedListeners.size).toBe(1);

    stopIntervals(state);
    expect(state.feedUnsub).toBeNull();
    expect(state.feedListeners.size).toBe(0);
  });

  it("is safe to call when already stopped", () => {
    const state = makeState();
    activeState = state;
    stopIntervals(state); // no-op, nothing to clear
    expect(state.captureInterval).toBeNull();
  });

  it("feed listener broadcasts to clients", () => {
    const state = makeState();
    activeState = state;
    const sentMessages: string[] = [];
    state.clients.add({ send: (msg: string) => sentMessages.push(msg) } as any);
    startIntervals(state, () => {});

    // Fire the feed listener
    const listener = [...state.feedListeners][0];
    listener({
      timestamp: new Date().toISOString(),
      oracle: "neo",
      host: "local",
      event: "SubagentStart",
      project: "test",
      sessionId: "",
      message: "test event",
      ts: Date.now(),
    });

    expect(sentMessages).toHaveLength(1);
    const parsed = JSON.parse(sentMessages[0]);
    expect(parsed.type).toBe("feed");
    expect(parsed.event.oracle).toBe("neo");
  });
});
