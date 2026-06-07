/**
 * install-server-intervals-extra-coverage.test.ts
 *
 * Branch coverage for engine interval orchestration. Kept isolated because it
 * patches timer globals and mocks transport/capture modules.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

let config: Record<string, any> = {};
let peers: unknown[] = [];
let aggregated: any[] = [];
let tmuxSessions: any[] = [];
let tmuxShouldThrow = false;
let aggregateShouldThrow = false;
let captureCalls: unknown[] = [];
let previewCalls: unknown[] = [];
let broadcastSessionCalls: unknown[] = [];
let teamsCalls: unknown[] = [];
let busyCalls: unknown[] = [];
let aggregateCalls: unknown[] = [];

mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/engine/capture"), () => ({
  pushCapture: (ws: unknown, lastContent: unknown) => { captureCalls.push([ws, lastContent]); },
  pushPreviews: (ws: unknown, lastPreviews: unknown) => { previewCalls.push([ws, lastPreviews]); },
  broadcastSessions: async (clients: unknown, cache: { sessions: any[] }, peerSessions: any[]) => {
    broadcastSessionCalls.push([clients, cache, peerSessions]);
    const next = [{ name: "local", windows: [{ index: 1, name: "alpha-oracle", active: true }] }];
    cache.sessions = next;
    return next;
  },
  sendBusyAgents: (ws: unknown, sessions: unknown) => { busyCalls.push([ws, sessions]); },
}));
mock.module(import.meta.resolve("../../src/engine/teams"), () => ({
  broadcastTeams: (clients: unknown, lastTeamsJson: unknown) => { teamsCalls.push([clients, lastTeamsJson]); },
}));
mock.module(import.meta.resolve("../../src/core/transport/peers"), () => ({
  getPeers: () => peers,
  getAggregatedSessions: async (seed: unknown[]) => {
    aggregateCalls.push(seed);
    if (aggregateShouldThrow) throw new Error("peer aggregation failed");
    return aggregated;
  },
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmux: {
    listAll: async () => {
      if (tmuxShouldThrow) throw new Error("tmux unavailable");
      return tmuxSessions;
    },
  },
}));

const { startIntervals, stopIntervals, sendInitialSessions } = await import("../../src/engine/engine-intervals.ts?extra-coverage");

const originalTimers = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

type TimerRecord = { token: { id: number }; callback: () => unknown; ms: number };
let timers: TimerRecord[] = [];
let cleared: unknown[] = [];

function makeWs(label: string) {
  const sent: string[] = [];
  return {
    label,
    sent,
    send: (message: string) => { sent.push(message); },
  } as any;
}

function makeState(overrides: Partial<any> = {}) {
  return {
    clients: new Set([makeWs("one"), makeWs("two")]),
    lastContent: new Map(),
    lastPreviews: new Map(),
    sessionCache: { sessions: [], json: "" },
    peerSessionsCache: [],
    status: {
      detectCalls: [] as unknown[],
      statuses: new Map([["local:1", "ready"]]),
      async detect(...args: unknown[]) { this.detectCalls.push(args); },
      getStatus(target: string) { return this.statuses.get(target); },
    },
    lastTeamsJson: { value: "" },
    feedListeners: new Set<(event: unknown) => void>(),
    feedBuffer: [],
    transportRouter: {
      published: [] as unknown[],
      rejectPresence: false,
      async publishPresence(payload: unknown) {
        this.published.push(payload);
        if (this.rejectPresence) throw new Error("presence offline");
      },
    },
    captureInterval: null,
    sessionInterval: null,
    previewInterval: null,
    statusInterval: null,
    teamsInterval: null,
    peerInterval: null,
    crashCheckInterval: null,
    feedUnsub: null,
    ...overrides,
  };
}

beforeEach(() => {
  config = { node: "m5", triggers: [] };
  peers = [];
  aggregated = [{ name: "peer", windows: [], source: "remote" }];
  tmuxSessions = [{ name: "cached", windows: [{ index: 2, name: "cached-oracle", active: false }] }];
  tmuxShouldThrow = false;
  aggregateShouldThrow = false;
  captureCalls = [];
  previewCalls = [];
  broadcastSessionCalls = [];
  teamsCalls = [];
  busyCalls = [];
  aggregateCalls = [];
  timers = [];
  cleared = [];
  globalThis.setInterval = ((callback: () => unknown, ms?: number) => {
    const token = { id: timers.length + 1 };
    timers.push({ token, callback, ms: Number(ms) });
    return token as never;
  }) as typeof setInterval;
  globalThis.clearInterval = ((token: unknown) => { cleared.push(token); }) as typeof clearInterval;
});

afterEach(() => {
  globalThis.setInterval = originalTimers.setInterval;
  globalThis.clearInterval = originalTimers.clearInterval;
});

describe("engine interval orchestration", () => {
  test("startIntervals wires each timer, presence publishing, crash checks, and feed fanout", async () => {
    const state = makeState();
    let crashes = 0;

    startIntervals(state, () => { crashes += 1; });
    startIntervals(state, () => { crashes += 100; });

    expect(timers.map(t => t.ms)).toEqual([50, 5000, 10000, 2000, 3000, 3000, 30000]);
    expect(state.feedListeners.size).toBe(1);
    expect(timers).toHaveLength(7);

    timers[0].callback();
    expect(captureCalls).toHaveLength(2);

    await timers[1].callback();
    expect(broadcastSessionCalls[0]?.[2]).toEqual([]);
    expect(state.sessionCache.sessions[0].name).toBe("local");

    peers = ["remote"];
    await timers[2].callback();
    expect(state.peerSessionsCache).toEqual(aggregated);
    expect(aggregateCalls).toEqual([[]]);
    peers = [];
    await timers[2].callback();
    expect(state.peerSessionsCache).toEqual([]);

    timers[3].callback();
    expect(previewCalls).toHaveLength(2);

    await timers[4].callback();
    expect(state.status.detectCalls).toHaveLength(1);
    expect(state.transportRouter.published).toEqual([{
      oracle: "alpha",
      host: "m5",
      status: "ready",
      timestamp: expect.any(Number),
    }]);

    timers[5].callback();
    expect(teamsCalls).toHaveLength(1);
    timers[6].callback();
    expect(crashes).toBe(1);

    const feedWs = [...state.clients][0];
    for (const listener of state.feedListeners) listener({ type: "note", text: "hi" });
    expect(feedWs.sent.at(-1)).toBe(JSON.stringify({ type: "feed", event: { type: "note", text: "hi" } }));
  });

  test("stopIntervals respects active clients and triggers, then clears timers and unsubscribes", () => {
    const state = makeState();
    let unsubscribed = 0;
    startIntervals(state, () => {});
    state.feedUnsub = () => { unsubscribed += 1; };

    stopIntervals(state);
    expect(cleared).toEqual([]);

    state.clients.clear();
    config.triggers = [{ name: "keepalive" }];
    stopIntervals(state);
    expect(cleared).toEqual([]);

    config.triggers = [];
    stopIntervals(state);

    expect(cleared).toHaveLength(7);
    expect(unsubscribed).toBe(1);
    expect(state.captureInterval).toBeNull();
    expect(state.peerInterval).toBeNull();
    expect(state.feedUnsub).toBeNull();
  });

  test("stopIntervals invokes the installed feed unsubscribe and presence publish rejections stay soft", async () => {
    const state = makeState({
      sessionCache: { sessions: [{ name: "local", windows: [{ index: 1, name: "alpha-oracle", active: true }] }], json: "" },
    });
    startIntervals(state, () => {});
    expect(state.feedListeners.size).toBe(1);

    state.transportRouter.rejectPresence = true;
    await timers[4].callback();
    await Promise.resolve();
    expect(state.transportRouter.published).toHaveLength(1);

    state.clients.clear();
    stopIntervals(state);
    expect(state.feedListeners.size).toBe(0);
    expect(state.feedUnsub).toBeNull();
  });

  test("sendInitialSessions combines local cache, tmux fallback, peer cache, and busy-agent scan", async () => {
    const ws = makeWs("initial");
    const cachedState = makeState({
      sessionCache: { sessions: [{ name: "cached-local", windows: [] }], json: "" },
      peerSessionsCache: [{ name: "cached-peer", windows: [], source: "peer" }],
    });
    await sendInitialSessions(ws, cachedState);
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "sessions",
      sessions: [
        { name: "cached-local", windows: [] },
        { name: "cached-peer", windows: [], source: "peer" },
      ],
    });
    expect(busyCalls.at(-1)).toEqual([ws, [{ name: "cached-local", windows: [] }]]);

    const fetchedWs = makeWs("fetched");
    peers = ["remote"];
    const fetchedState = makeState({ clients: new Set(), sessionCache: { sessions: [], json: "" } });
    await sendInitialSessions(fetchedWs, fetchedState);
    expect(fetchedState.sessionCache.sessions).toEqual(tmuxSessions);
    expect(fetchedState.peerSessionsCache).toEqual(aggregated);
    expect(JSON.parse(fetchedWs.sent[0]).sessions).toEqual([...tmuxSessions, ...aggregated]);

    const emptyWs = makeWs("empty");
    tmuxShouldThrow = true;
    peers = [];
    const emptyState = makeState({ clients: new Set(), sessionCache: { sessions: [], json: "" } });
    await sendInitialSessions(emptyWs, emptyState);
    expect(JSON.parse(emptyWs.sent[0])).toEqual({ type: "sessions", sessions: [] });

    const peerFailureWs = makeWs("peer-failure");
    tmuxShouldThrow = false;
    peers = ["remote"];
    aggregateShouldThrow = true;
    const peerFailureState = makeState({ clients: new Set(), sessionCache: { sessions: [], json: "" }, peerSessionsCache: [] });
    await sendInitialSessions(peerFailureWs, peerFailureState);
    expect(peerFailureState.peerSessionsCache).toEqual([]);
    expect(JSON.parse(peerFailureWs.sent[0]).sessions).toEqual(tmuxSessions);
  });
});
