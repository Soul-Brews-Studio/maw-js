import { describe, expect, test } from "bun:test";
import { classifyError, TransportRouter, type Transport } from "../src/core/transport/transport";

type Handler<T> = (value: T) => void;
type FakeTransportOverrides = Partial<Transport> & { name: string; listPeers?: () => unknown[] };

function fakeTransport(overrides: FakeTransportOverrides): Transport & {
  messages: Handler<any>[];
  presences: Handler<any>[];
  feeds: Handler<any>[];
  sent: string[];
} {
  const messages: Handler<any>[] = [];
  const presences: Handler<any>[] = [];
  const feeds: Handler<any>[] = [];
  const sent: string[] = [];
  return {
    name: overrides.name,
    connected: overrides.connected ?? true,
    connect: overrides.connect ?? (async () => {}),
    disconnect: overrides.disconnect ?? (async () => {}),
    canReach: overrides.canReach ?? (() => true),
    send: overrides.send ?? (async (_target, message) => { sent.push(message); return true; }),
    publishPresence: overrides.publishPresence ?? (async () => {}),
    publishFeed: overrides.publishFeed ?? (async () => {}),
    onMessage: (handler) => messages.push(handler),
    onPresence: (handler) => presences.push(handler),
    onFeed: (handler) => feeds.push(handler),
    listPeers: overrides.listPeers,
    messages,
    presences,
    feeds,
    sent,
  } as Transport & { listPeers?: () => unknown[]; messages: Handler<any>[]; presences: Handler<any>[]; feeds: Handler<any>[]; sent: string[] };
}

describe("transport coverage — failure classification", () => {
  test("classifyError maps retryable and fatal errors", () => {
    expect(classifyError("ETIMEDOUT while dialing")).toEqual({ reason: "timeout", retryable: true });
    expect(classifyError("ECONNREFUSED")).toEqual({ reason: "unreachable", retryable: true });
    expect(classifyError("403 forbidden")).toEqual({ reason: "auth", retryable: false });
    expect(classifyError("429 too many requests")).toEqual({ reason: "rate_limit", retryable: true });
    expect(classifyError("peer rejected message")).toEqual({ reason: "rejected", retryable: false });
    expect(classifyError("JSON parse failed")).toEqual({ reason: "parse_error", retryable: false });
    expect(classifyError(null)).toEqual({ reason: "unknown", retryable: false });
  });
});

describe("TransportRouter", () => {
  const target = { oracle: "neo", tmuxTarget: "neo:1" };

  test("routes through the first connected reachable transport", async () => {
    const router = new TransportRouter();
    const first = fakeTransport({ name: "tmux" });
    const second = fakeTransport({ name: "http" });
    router.register(first);
    router.register(second);

    expect(await router.send(target, "hi", "codex")).toEqual({ ok: true, via: "tmux", retryable: false });
    expect(first.sent).toEqual(["hi"]);
    expect(second.sent).toEqual([]);
  });

  test("retryable transport errors fall through to the next route", async () => {
    const router = new TransportRouter();
    router.register(fakeTransport({ name: "mqtt", send: async () => { throw new Error("timeout"); } }));
    router.register(fakeTransport({ name: "http" }));

    expect(await router.send(target, "hello", "codex")).toEqual({ ok: true, via: "http", retryable: false });
  });

  test("fatal transport errors stop failover", async () => {
    const router = new TransportRouter();
    const fallback = fakeTransport({ name: "http" });
    router.register(fakeTransport({ name: "peer", send: async () => { throw new Error("401 unauthorized"); } }));
    router.register(fallback);

    expect(await router.send(target, "secret", "codex")).toEqual({ ok: false, via: "peer", reason: "auth", retryable: false });
    expect(fallback.sent).toEqual([]);
  });

  test("false send result and disconnected transports continue to fallback", async () => {
    const router = new TransportRouter();
    router.register(fakeTransport({ name: "offline", connected: false }));
    router.register(fakeTransport({ name: "rejecting", send: async () => false }));
    router.register(fakeTransport({ name: "http" }));

    expect(await router.send(target, "fallback", "codex")).toEqual({ ok: true, via: "http", retryable: false });
  });


  test("connect/disconnect and broadcast methods fan out to connected transports", async () => {
    const calls: string[] = [];
    const router = new TransportRouter();
    router.register(fakeTransport({
      name: "online",
      connect: async () => { calls.push("connect"); },
      disconnect: async () => { calls.push("disconnect"); },
      publishPresence: async () => { calls.push("presence"); },
      publishFeed: async () => { calls.push("feed"); },
    }));
    router.register(fakeTransport({
      name: "offline",
      connected: false,
      connect: async () => { calls.push("offline-connect"); },
      disconnect: async () => { calls.push("offline-disconnect"); },
      publishPresence: async () => { calls.push("offline-presence"); },
      publishFeed: async () => { calls.push("offline-feed"); },
    }));

    await router.connectAll();
    await router.publishPresence({ oracle: "neo", host: "m5", status: "ready", timestamp: 1 });
    await router.publishFeed({ type: "message", ts: 1 } as any);
    await router.disconnectAll();

    expect(calls).toEqual(["connect", "offline-connect", "presence", "feed", "disconnect", "offline-disconnect"]);
  });

  test("no reachable transport returns an explicit unreachable result", async () => {
    const router = new TransportRouter();
    router.register(fakeTransport({ name: "miss", canReach: () => false }));

    expect(await router.send(target, "hi", "codex")).toEqual({ ok: false, via: "none", reason: "unreachable", retryable: false });
  });

  test("discovery ignores transports whose listPeers throws", () => {
    const router = new TransportRouter();
    router.register(fakeTransport({ name: "bad-scout", listPeers: () => { throw new Error("boom"); } }));
    router.register(fakeTransport({ name: "good-scout", listPeers: () => [{ id: "peer-b" }] }));

    expect(router.listDiscoveredPeers()).toEqual([{ id: "peer-b" }]);
  });

  test("event handlers and discovery are wired through registered transports", async () => {
    const router = new TransportRouter();
    const transport = fakeTransport({ name: "scout", listPeers: () => [{ id: "peer-a" }] });
    router.register(transport);

    const messages: unknown[] = [];
    const presences: unknown[] = [];
    const feeds: unknown[] = [];
    router.onMessage((msg) => messages.push(msg));
    router.onPresence((presence) => presences.push(presence));
    router.onFeed((event) => feeds.push(event));

    transport.messages[0]?.({ from: "a", to: "b", body: "hi", timestamp: 1, transport: "tmux" });
    transport.presences[0]?.({ oracle: "neo", host: "m5", status: "ready", timestamp: 1 });
    transport.feeds[0]?.({ type: "message", ts: 1 } as any);

    expect(messages).toHaveLength(1);
    expect(presences).toHaveLength(1);
    expect(feeds).toHaveLength(1);
    expect(router.status()).toEqual([{ name: "scout", connected: true }]);
    expect(router.listDiscoveredPeers()).toEqual([{ id: "peer-a" }]);
  });
});
