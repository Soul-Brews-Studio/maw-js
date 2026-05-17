/**
 * Runtime coverage for ScoutTransport without opening real UDP sockets or
 * mutating the real peer store. Mocks are gated and delegate when inactive so
 * this main-suite file contributes to `test:coverage` without polluting others.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import type { Socket } from "dgram";
import { makeHello, makeScout, MULTICAST_ADDR, MULTICAST_PORT } from "../src/transports/scout-protocol";
import { ScoutState } from "../src/transports/scout-state";

const _rDgram = await import("dgram");
const _rStore = await import("../src/lib/peers/store");
const _rPair = await import("../src/transports/scout-pair");
const _rApiPair = await import("../src/api/pair");

const real = {
  createSocket: _rDgram.createSocket,
  loadPeers: _rStore.loadPeers,
  initiatePair: _rPair.initiatePair,
  recordHelloZid: _rApiPair.recordHelloZid,
  fetch: globalThis.fetch,
  log: console.log,
  warn: console.warn,
};

let mockActive = false;
let sockets: FakeSocket[] = [];
let createSocketError: Error | null = null;
let addMembershipError: Error | null = null;
let bindError: Error | null = null;
let loadPeersError: Error | null = null;
let loadPeersValue: { peers: Record<string, unknown> } = { peers: {} };
let pairCalls: Array<{ zid: string; localNode: string; localOracle: string; localPort: number }> = [];
let pairResults: Array<{ ok: boolean; error?: string }> = [];
let recordHelloCalls: string[] = [];
let fetchCalls: Array<{ url: string; init: RequestInit | undefined; body: any }> = [];
let fetchQueue: Array<Response | Error> = [];
let logs: string[] = [];
let warns: string[] = [];
let transports: any[] = [];

class FakeSocket {
  handlers = new Map<string, Function[]>();
  sent: Array<{ message: any; port: number; host: string }> = [];
  memberships: string[] = [];
  ttl: number | null = null;
  boundPort: number | null = null;
  closed = false;
  dropped: string[] = [];

  on(event: string, handler: Function): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  bind(port: number, cb?: () => void): this {
    this.boundPort = port;
    if (bindError) {
      queueMicrotask(() => this.emit("error", bindError));
      return this;
    }
    cb?.();
    return this;
  }

  addMembership(addr: string): void {
    if (addMembershipError) throw addMembershipError;
    this.memberships.push(addr);
  }

  setMulticastTTL(ttl: number): void {
    this.ttl = ttl;
  }

  dropMembership(addr: string): void {
    this.dropped.push(addr);
  }

  close(): void {
    this.closed = true;
  }

  send(buf: Buffer, port: number, host: string): void {
    let message: any = buf.toString();
    try {
      message = JSON.parse(buf.toString());
    } catch {}
    this.sent.push({ message, port, host });
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  emitMessage(message: any, address = "10.0.0.2", port = 45678): void {
    const buf = Buffer.from(typeof message === "string" ? message : JSON.stringify(message));
    this.emit("message", buf, { address, port });
  }
}

mock.module("dgram", () => ({
  ..._rDgram,
  createSocket: (...args: Parameters<typeof _rDgram.createSocket>) => {
    if (!mockActive) return real.createSocket(...args);
    if (createSocketError) throw createSocketError;
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as Socket;
  },
}));

mock.module(join(import.meta.dir, "../src/lib/peers/store"), () => ({
  ..._rStore,
  loadPeers: () => {
    if (!mockActive) return real.loadPeers();
    if (loadPeersError) throw loadPeersError;
    return loadPeersValue as any;
  },
}));

mock.module(join(import.meta.dir, "../src/transports/scout-pair"), () => ({
  ..._rPair,
  initiatePair: async (peer: any, localNode: string, localOracle: string, localPort: number, deps?: any) => {
    if (!mockActive) return real.initiatePair(peer, localNode, localOracle, localPort, deps);
    pairCalls.push({ zid: peer.zid, localNode, localOracle, localPort });
    return pairResults.shift() ?? { ok: true };
  },
}));

mock.module(join(import.meta.dir, "../src/api/pair"), () => ({
  ..._rApiPair,
  recordHelloZid: (zid: string, now?: number) => {
    if (!mockActive) return real.recordHelloZid(zid, now);
    recordHelloCalls.push(zid);
  },
}));

const { ScoutTransport } = await import("../src/transports/scout");

function makeTransport(overrides: Record<string, unknown> = {}) {
  const transport = new ScoutTransport({
    node: "local-node",
    oracle: "local-oracle",
    port: 4567,
    oracles: ["local-oracle"],
    ...overrides,
  } as any);
  transports.push(transport);
  return transport as any;
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockActive = true;
  sockets = [];
  createSocketError = null;
  addMembershipError = null;
  bindError = null;
  loadPeersError = null;
  loadPeersValue = { peers: {} };
  pairCalls = [];
  pairResults = [];
  recordHelloCalls = [];
  fetchCalls = [];
  fetchQueue = [];
  logs = [];
  warns = [];
  transports = [];

  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.warn = (...parts: unknown[]) => { warns.push(parts.map(String).join(" ")); };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: any = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {}
    }
    fetchCalls.push({ url, init, body });
    const next = fetchQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(async () => {
  for (const transport of transports) await transport.disconnect?.();
  mockActive = false;
  globalThis.fetch = real.fetch;
  console.log = real.log;
  console.warn = real.warn;
});

describe("ScoutTransport coverage", () => {
  test("connect wires UDP handlers and dispatches scout, hello, and legacy announce messages", async () => {
    const transport = makeTransport();
    transport.state = new ScoutState("ff-local");
    const presences: any[] = [];
    transport.onPresence((presence: any) => presences.push(presence));
    transport.onFeed(() => {});
    pairResults.push({ ok: true });

    await transport.connect();
    const socket = sockets[0];

    expect(transport.connected).toBe(true);
    expect(socket.boundPort).toBe(MULTICAST_PORT);
    expect(socket.memberships).toEqual([MULTICAST_ADDR]);
    expect(socket.ttl).toBe(2);
    expect(logs.some((line) => line.includes("[scout] listening"))).toBe(true);

    socket.emitMessage("not json");
    socket.emitMessage(makeScout("ff-local"), "10.0.0.9", 2222);
    expect(socket.sent).toHaveLength(0);

    socket.emitMessage(makeScout("00-remote"), "10.0.0.9", 2222);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ port: 2222, host: "10.0.0.9" });
    expect(socket.sent[0].message).toMatchObject({
      type: "maw-hello",
      zid: "ff-local",
      node: "local-node",
      oracle: "local-oracle",
      locators: ["http://local-node:4567"],
      oracles: ["local-oracle"],
    });

    socket.emitMessage(makeHello({
      zid: "00-hello",
      node: "remote-node",
      oracle: "remote-oracle",
      locators: ["http://remote:3456"],
      capabilities: ["pair", "send"],
      oracles: ["remote-oracle"],
    }), "10.0.0.3");
    await flushAsync();

    expect(recordHelloCalls).toEqual(["00-hello"]);
    expect(pairCalls).toEqual([{ zid: "00-hello", localNode: "local-node", localOracle: "local-oracle", localPort: 4567 }]);
    expect(transport.listPeers()[0]).toMatchObject({ node: "remote-node", host: "10.0.0.3", paired: true });
    expect(presences.some((p) => p.oracle === "remote-node" && p.host === "10.0.0.3" && p.status === "ready")).toBe(true);

    socket.emitMessage({ type: "maw-announce", node: "local-node", port: 1111, oracles: ["ignored"] }, "10.0.0.4");
    socket.emitMessage({ type: "maw-announce", node: "legacy-node", port: 0, oracles: ["legacy-oracle"] }, "10.0.0.4");

    expect(transport.listPeers().some((p: any) => p.node === "legacy-node" && p.locators[0] === "http://10.0.0.4:3456")).toBe(true);
    expect(logs.some((line) => line.includes("legacy peer: legacy-node"))).toBe(true);
    expect(presences.some((p) => p.oracle === "legacy-node" && p.host === "10.0.0.4" && p.status === "ready")).toBe(true);

    await transport.disconnect();
    expect(socket.dropped).toEqual([MULTICAST_ADDR]);
    expect(socket.closed).toBe(true);
    expect(transport.connected).toBe(false);
  });

  test("connect failures are fail-soft and leave the transport disconnected", async () => {
    addMembershipError = new Error("no multicast");
    const transport = makeTransport();

    await transport.connect();

    expect(transport.connected).toBe(false);
    expect(warns).toContain("[scout] connect failed: no multicast");
  });

  test("send routes through discovered peers and reports only confirmed deliveries", async () => {
    const transport = makeTransport();
    const delivered: any[] = [];
    transport.onMessage((msg: any) => delivered.push(msg));
    transport.state.handleHello(makeHello({
      zid: "peer-zid",
      node: "peer-node",
      oracle: "peer-oracle",
      locators: ["http://peer:3456"],
      oracles: ["alice-oracle"],
    }), "10.0.0.5");

    fetchQueue.push(Response.json({ ok: true }));
    await expect(transport.send({ host: "peer-node", oracle: "alice" }, "hello")).resolves.toBe(true);
    expect(fetchCalls[0]).toMatchObject({
      url: "http://peer:3456/api/send",
      body: { target: "alice", text: "hello" },
    });
    expect(delivered[0]).toMatchObject({ from: "local-node", to: "alice", body: "hello", transport: "scout" });

    fetchQueue.push(Response.json({ ok: false }));
    await expect(transport.send({ host: "peer-node", oracle: "alice" }, "nope")).resolves.toBe(false);
    fetchQueue.push(new Response("bad", { status: 500 }));
    await expect(transport.send({ oracle: "alice" }, "bad")).resolves.toBe(false);
    fetchQueue.push(new Error("offline"));
    await expect(transport.send({ host: "peer-node", oracle: "alice" }, "offline")).resolves.toBe(false);

    await expect(transport.send({ host: "missing", oracle: "nobody" }, "miss")).resolves.toBe(false);

    transport.state.handleHello(makeHello({
      zid: "empty-locator",
      node: "empty-node",
      oracle: "empty-oracle",
      locators: [],
      oracles: ["empty-oracle"],
    }), "10.0.0.6");
    await expect(transport.send({ host: "empty-node", oracle: "empty-oracle" }, "miss")).resolves.toBe(false);
  });

  test("presence and feed publishing use the scout socket plus best-effort peer fanout", async () => {
    const transport = makeTransport();
    const socket = new FakeSocket();
    transport.socket = socket;
    transport._connected = true;
    transport.state = new ScoutState("ff-local");
    transport.state.handleHello(makeHello({
      zid: "peer-a",
      node: "node-a",
      oracle: "oracle-a",
      locators: ["http://a:3456"],
      oracles: ["oracle-a"]
    }), "10.0.0.7");
    transport.state.handleHello(makeHello({
      zid: "peer-b",
      node: "node-b",
      oracle: "oracle-b",
      locators: [],
      oracles: ["oracle-b"]
    }), "10.0.0.8");

    await transport.publishPresence({ oracle: "local-oracle", host: "local-node", status: "ready", timestamp: 1 });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ port: MULTICAST_PORT, host: MULTICAST_ADDR });
    expect(socket.sent[0].message).toMatchObject({ type: "maw-scout", zid: "ff-local" });

    await transport.publishFeed({ type: "note", ts: 123, payload: { body: "hello" } } as any);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({ url: "http://a:3456/api/feed" });
    expect(fetchCalls[0].body).toMatchObject({ type: "note" });

    fetchQueue.push(new Error("feed offline"));
    await transport.publishFeed({ type: "note", ts: 124, payload: { body: "ignored" } } as any);
    await flushAsync();
    expect(fetchCalls).toHaveLength(2);

    expect(transport.canReach({ host: "local", oracle: "oracle-a" })).toBe(false);
    expect(transport.canReach({ host: "localhost", oracle: "oracle-a" })).toBe(false);
    expect(transport.canReach({ oracle: "oracle-a" })).toBe(false);
    expect(transport.canReach({ host: "node-a", oracle: "ignored" })).toBe(true);
    expect(transport.canReach({ host: "remote", oracle: "oracle-a" })).toBe(true);
    expect(transport.canReach({ host: "remote", oracle: "missing" })).toBe(false);
  });

  test("the scout loop callback sends once and reschedules while connected", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const scheduled: Function[] = [];
    (globalThis as any).setTimeout = (fn: Function) => {
      scheduled.push(fn);
      return scheduled.length;
    };
    (globalThis as any).clearTimeout = () => {};

    try {
      const transport = makeTransport();
      const socket = new FakeSocket();
      transport.socket = socket;
      transport._connected = true;
      transport.state = new ScoutState("ff-local");

      transport.scheduleScout();
      expect(scheduled).toHaveLength(1);

      scheduled[0]();

      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0]).toMatchObject({ port: MULTICAST_PORT, host: MULTICAST_ADDR });
      expect(socket.sent[0].message).toMatchObject({ type: "maw-scout", zid: "ff-local" });
      expect(scheduled).toHaveLength(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("the connected prune interval invokes stale-peer pruning", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalClearInterval = globalThis.clearInterval;
    const intervals: Function[] = [];
    (globalThis as any).setTimeout = () => 1;
    (globalThis as any).setInterval = (fn: Function) => {
      intervals.push(fn);
      return intervals.length;
    };
    (globalThis as any).clearTimeout = () => {};
    (globalThis as any).clearInterval = () => {};

    try {
      const transport = makeTransport();
      const presences: any[] = [];
      transport.onPresence((p: any) => presences.push(p));
      transport.state = new ScoutState("ff-local");
      transport.state.handleHello(makeHello({
        zid: "interval-old",
        node: "interval-node",
        oracle: "interval-oracle",
        locators: ["http://interval:3456"],
        oracles: ["interval-oracle"],
      }), "10.0.0.14");
      transport.state.discoveredPeers.get("interval-old")!.lastSeen = Date.now() - 31_000;

      await transport.connect();
      expect(intervals).toHaveLength(1);
      intervals[0]();

      expect(transport.state.findPeerByZid("interval-old")).toBeUndefined();
      expect(presences).toContainEqual(expect.objectContaining({ oracle: "interval-node", status: "offline" }));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("autoPair=false records discovery and presence without starting pairing", async () => {
    const transport = makeTransport({ autoPair: false });
    transport.state = new ScoutState("ff-local");
    const presences: any[] = [];
    transport.onPresence((p: any) => presences.push(p));

    transport.handleHello(makeHello({
      zid: "00-no-pair",
      node: "quiet-node",
      oracle: "quiet-oracle",
      locators: ["http://quiet:3456"],
      capabilities: ["pair"],
      oracles: ["quiet-oracle"],
    }), "10.0.0.10");
    transport.handleHello(makeHello({
      zid: "00-no-pair",
      node: "quiet-node",
      oracle: "quiet-oracle",
      locators: ["http://quiet:3456"],
      capabilities: ["pair"],
      oracles: ["quiet-oracle"],
    }), "10.0.0.10");
    await flushAsync();

    expect(pairCalls).toHaveLength(0);
    expect(logs.filter((line) => line.includes("discovered: quiet-node"))).toHaveLength(1);
    expect(presences).toHaveLength(2);
  });

  test("pairing failures clear pending state and missing peers are ignored", async () => {
    const transport = makeTransport();
    transport.state = new ScoutState("ff-local");
    transport.state.markPending("missing");

    await transport.doPair("missing");
    expect(transport.state.pendingConnections.has("missing")).toBe(false);

    transport.state.handleHello(makeHello({
      zid: "00-fail",
      node: "fail-node",
      oracle: "fail-oracle",
      locators: ["http://fail:3456"],
      capabilities: [],
      oracles: ["fail-oracle"],
    }), "10.0.0.11");
    transport.state.markPending("00-fail");
    pairResults.push({ ok: false, error: "denied" });

    await transport.doPair("00-fail");

    expect(transport.state.pendingConnections.has("00-fail")).toBe(false);
    expect(warns).toContain("[scout] pair failed with fail-node: denied");
  });

  test("stale peer pruning emits offline presence and clears pending entries", () => {
    const transport = makeTransport();
    const presences: any[] = [];
    transport.onPresence((p: any) => presences.push(p));
    transport.state.handleHello(makeHello({
      zid: "old-peer",
      node: "old-node",
      oracle: "old-oracle",
      locators: ["http://old:3456"],
      oracles: ["old-oracle"],
    }), "10.0.0.12");
    transport.state.discoveredPeers.get("old-peer")!.lastSeen = Date.now() - 31_000;
    transport.state.markPending("old-peer");

    transport.pruneStale();

    expect(transport.state.findPeerByZid("old-peer")).toBeUndefined();
    expect(transport.state.pendingConnections.has("old-peer")).toBe(false);
    expect(logs).toContain("[scout] peer gone: old-node");
    expect(presences).toContainEqual(expect.objectContaining({ oracle: "old-node", host: "", status: "offline" }));
  });

  test("loadExistingPeers marks already-discovered peers as paired and swallows store failures", () => {
    const transport = makeTransport();
    transport.state.handleHello(makeHello({
      zid: "known-zid",
      node: "known-node",
      oracle: "known-oracle",
      locators: ["http://known:3456"],
      oracles: ["known-oracle"],
    }), "10.0.0.13");

    loadPeersValue = { peers: { "known-node": {}, other: {} } };
    transport.loadExistingPeers();
    expect(transport.state.findPeerByZid("known-zid")!.paired).toBe(true);

    loadPeersError = new Error("bad peers file");
    expect(() => transport.loadExistingPeers()).not.toThrow();
  });

  test("createSocket failures are reported by connect", async () => {
    createSocketError = new Error("socket unavailable");
    const transport = makeTransport();

    await transport.connect();

    expect(transport.connected).toBe(false);
    expect(warns).toContain("[scout] connect failed: socket unavailable");
  });

  test("socket error during bind rejects connect through the fail-soft path", async () => {
    bindError = new Error("bind failed");
    const transport = makeTransport();

    await transport.connect();

    expect(transport.connected).toBe(false);
    expect(warns).toContain("[scout] connect failed: bind failed");
  });
});
