/**
 * Runtime coverage for mDNS transport without opening UDP sockets or sending
 * real HTTP requests. The dgram mock delegates when inactive so this file can
 * live in the default suite without changing unrelated network behavior.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { Socket } from "dgram";

const realDgram = await import("dgram");

type Handler = (...args: any[]) => void;

class FakeSocket {
  handlers = new Map<string, Handler[]>();
  sent: Array<{ message: string; port: number; address: string }> = [];
  memberships: string[] = [];
  ttl: number | null = null;
  closed = false;
  dropped: string[] = [];
  bindPort: number | null = null;
  addMembershipError: Error | null = null;
  sendError: Error | null = null;

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  bind(port: number, callback?: () => void) {
    this.bindPort = port;
    callback?.();
    return this;
  }

  addMembership(address: string) {
    if (this.addMembershipError) throw this.addMembershipError;
    this.memberships.push(address);
  }

  setMulticastTTL(ttl: number) {
    this.ttl = ttl;
  }

  send(message: string | Buffer, port: number, address: string) {
    if (this.sendError) throw this.sendError;
    this.sent.push({ message: String(message), port, address });
  }

  dropMembership(address: string) {
    this.dropped.push(address);
  }

  close() {
    this.closed = true;
  }

  emitMessage(payload: unknown, address = "10.0.0.42") {
    const buffer = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
    for (const handler of this.handlers.get("message") ?? []) {
      handler(buffer, { address });
    }
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

let mockActive = false;
let sockets: FakeSocket[] = [];
let nextSocket: FakeSocket | null = null;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
let logs: string[] = [];
let warns: string[] = [];
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalWarn = console.warn;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let intervalCallbacks: Array<() => void> = [];
let clearedIntervals: unknown[] = [];

mock.module("dgram", () => ({
  ...realDgram,
  createSocket: (...args: Parameters<typeof realDgram.createSocket>) => {
    if (!mockActive) return realDgram.createSocket(...args);
    const socket = nextSocket ?? new FakeSocket();
    nextSocket = null;
    sockets.push(socket);
    return socket as unknown as Socket;
  },
}));

const { MdnsTransport } = await import("../src/transports/mdns");

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  mockActive = true;
  sockets = [];
  nextSocket = null;
  fetchCalls = [];
  fetchImpl = async () => jsonResponse({ ok: true });
  logs = [];
  warns = [];
  intervalCallbacks = [];
  clearedIntervals = [];
  globalThis.setInterval = ((handler: TimerHandler, _timeout?: number, ..._args: unknown[]) => {
    intervalCallbacks.push(typeof handler === "function" ? handler as () => void : () => eval(String(handler)));
    return { mdnsTestTimer: intervalCallbacks.length } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    clearedIntervals.push(id);
  }) as typeof clearInterval;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return fetchImpl(String(url), init);
  }) as typeof fetch;
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.warn = (...parts: unknown[]) => { warns.push(parts.map(String).join(" ")); };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  console.log = originalLog;
  console.warn = originalWarn;
  mockActive = false;
});

describe("MdnsTransport discovery lifecycle", () => {
  test("connects, announces presence, records peers, and prunes stale nodes", async () => {
    const transport = new MdnsTransport({ node: "m5", port: 3456, oracles: ["mawjs-oracle"] });
    const presence: any[] = [];
    transport.onPresence((p) => presence.push(p));
    transport.onFeed(() => undefined);

    await transport.connect();
    const socket = sockets[0];

    expect(transport.connected).toBe(true);
    expect(socket.bindPort).toBe(31746);
    expect(socket.memberships).toEqual(["224.0.0.224"]);
    expect(socket.ttl).toBe(2);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0].message)).toMatchObject({
      type: "maw-announce",
      node: "m5",
      port: 3456,
      oracles: ["mawjs-oracle"],
    });
    expect(socket.sent[0]).toMatchObject({ port: 31746, address: "224.0.0.224" });

    socket.emitMessage("not json");
    socket.emitMessage({ type: "maw-announce", node: "m5", port: 9999 });
    expect(transport.listPeers()).toEqual([]);

    socket.emitMessage({ type: "maw-announce", node: "m6", port: 4567, oracles: ["pulse-oracle"] });
    expect(transport.listPeers()).toMatchObject([
      { node: "m6", host: "10.0.0.42", port: 4567, oracles: ["pulse-oracle"] },
    ]);
    expect(logs.some((line) => line.includes("[mdns] discovered: m6"))).toBe(true);
    expect(presence).toMatchObject([
      { oracle: "m6", host: "10.0.0.42", status: "ready" },
    ]);
    expect(transport.canReach({ host: "m6", oracle: "anything" })).toBe(true);
    expect(transport.canReach({ host: "remote", oracle: "pulse" })).toBe(true);
    expect(transport.canReach({ host: "local", oracle: "pulse" })).toBe(false);
    expect(transport.canReach({ host: "localhost", oracle: "pulse" })).toBe(false);
    expect(transport.canReach({ oracle: "pulse" })).toBe(false);

    socket.emitMessage({ type: "maw-announce", node: "m6", oracles: [] }, "10.0.0.43");
    expect(transport.listPeers()[0]).toMatchObject({ node: "m6", host: "10.0.0.43", port: 3456, oracles: [] });

    const peers = (transport as any).peers as Map<string, any>;
    peers.get("m6").lastSeen = Date.now() - 31_000;
    intervalCallbacks[0]();
    expect(socket.sent).toHaveLength(2);
    expect(transport.listPeers()).toEqual([]);
    expect(presence.at(-1)).toMatchObject({ oracle: "m6", host: "10.0.0.43", status: "offline" });
    expect(logs.some((line) => line.includes("[mdns] peer gone: m6"))).toBe(true);

    await transport.disconnect();
    expect(transport.connected).toBe(false);
    expect(socket.dropped).toEqual(["224.0.0.224"]);
    expect(socket.closed).toBe(true);
    expect(clearedIntervals).toHaveLength(1);
  });

  test("connect failure leaves the transport disconnected and logs the reason", async () => {
    const socket = new FakeSocket();
    socket.addMembershipError = new Error("multicast denied");
    nextSocket = socket;
    const transport = new MdnsTransport({ node: "m5", port: 3456 });

    await transport.connect();

    expect(transport.connected).toBe(false);
    expect(warns).toEqual(["[mdns] connect failed: multicast denied"]);
    await transport.disconnect();
  });
});

describe("MdnsTransport send and feed", () => {
  async function connectedWithPeer() {
    const transport = new MdnsTransport({ node: "m5", port: 3456, oracles: ["mawjs-oracle"] });
    await transport.connect();
    sockets[0].emitMessage({ type: "maw-announce", node: "m6", port: 4567, oracles: ["pulse-oracle"] });
    return transport;
  }

  test("send posts to the discovered peer and emits a local sent-message event", async () => {
    const transport = await connectedWithPeer();
    const messages: any[] = [];
    transport.onMessage((msg) => messages.push(msg));

    await expect(transport.send({ host: "m6", oracle: "pulse-oracle" }, "hello")).resolves.toBe(true);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://10.0.0.42:4567/api/send");
    expect(fetchCalls[0].init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "pulse-oracle", text: "hello" }),
    });
    expect(messages).toMatchObject([
      { from: "m5", to: "pulse-oracle", body: "hello", transport: "http" },
    ]);

    await transport.disconnect();
  });

  test("send returns false for no peer, rejected responses, and thrown fetches", async () => {
    const transport = await connectedWithPeer();

    await expect(transport.send({ host: "unknown", oracle: "none" }, "hello")).resolves.toBe(false);

    fetchImpl = async () => jsonResponse({ ok: true }, false);
    await expect(transport.send({ host: "m6", oracle: "pulse-oracle" }, "hello")).resolves.toBe(false);

    fetchImpl = async () => jsonResponse({ ok: false }, true);
    await expect(transport.send({ host: "m6", oracle: "pulse-oracle" }, "hello")).resolves.toBe(false);

    fetchImpl = async () => { throw new Error("offline"); };
    await expect(transport.send({ host: "m6", oracle: "pulse-oracle" }, "hello")).resolves.toBe(false);

    await transport.disconnect();
  });

  test("publishPresence announces and publishFeed fan-outs without surfacing fetch failures", async () => {
    const transport = await connectedWithPeer();
    const socket = sockets[0];
    fetchImpl = async () => { throw new Error("feed down"); };

    await transport.publishPresence({ oracle: "m5", host: "m5", status: "ready", timestamp: Date.now() });
    expect(socket.sent).toHaveLength(2);

    await transport.publishFeed({ type: "note", source: "test", text: "feed" } as any);
    expect(fetchCalls.at(-1)?.url).toBe("http://10.0.0.42:4567/api/feed");
    expect(fetchCalls.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note", source: "test", text: "feed" }),
    });

    await transport.disconnect();
  });

  test("disconnect is safe before connect and announce is a no-op while disconnected", async () => {
    const transport = new MdnsTransport({ node: "m5", port: 3456 });

    await transport.disconnect();
    (transport as any).announce();

    expect(transport.connected).toBe(false);
    expect(sockets).toEqual([]);
  });
});
