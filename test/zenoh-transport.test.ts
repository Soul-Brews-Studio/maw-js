import { describe, expect, test } from "bun:test";
import { ZenohTransport, type ZenohRuntime } from "../src/transports/zenoh";
import type { FeedEvent } from "../src/lib/feed";
import type { TransportMessage, TransportPresence } from "../src/core/transport/transport";

type Handler = (sample: unknown) => void;

function sample(value: unknown) {
  return {
    payload() {
      return {
        toBytes() {
          return new TextEncoder().encode(JSON.stringify(value));
        },
      };
    },
  };
}

function badSample(bytes = "not-json") {
  return {
    payload() {
      return {
        toBytes() {
          return new TextEncoder().encode(bytes);
        },
      };
    },
  };
}

function decode(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function createFakeZenoh(options: { putFails?: boolean; undeclareFails?: boolean; closeFails?: boolean } = {}) {
  const subscribers = new Map<string, Handler>();
  const undeclared: string[] = [];
  const puts: Array<{ topic: string; payload: Uint8Array }> = [];
  let openedLocator = "";
  let closed = false;

  class Config {
    constructor(public locator: string) {
      openedLocator = locator;
    }
  }

  const session = {
    liveliness() {
      return {
        async declareToken(key: string) {
          return {
            async undeclare() {
              if (options.undeclareFails) throw new Error("token undeclare failed");
              undeclared.push(`token:${key}`);
            },
          };
        },
      };
    },
    async declareSubscriber(topic: string, opts: { handler: Handler }) {
      subscribers.set(topic, opts.handler);
      return {
        async undeclare() {
          if (options.undeclareFails) throw new Error(`sub undeclare failed: ${topic}`);
          undeclared.push(`sub:${topic}`);
        },
      };
    },
    async put(topic: string, payload: Uint8Array) {
      if (options.putFails) throw new Error("put failed");
      puts.push({ topic, payload });
    },
    async close() {
      if (options.closeFails) throw new Error("close failed");
      closed = true;
    },
  };

  const runtime: ZenohRuntime = {
    Config,
    async open() {
      return session;
    },
  };

  return { runtime, subscribers, undeclared, puts, get openedLocator() { return openedLocator; }, get closed() { return closed; } };
}

const quietLogger = {
  log() {},
  warn() {},
};

describe("ZenohTransport", () => {
  test("connects through injectable zenoh runtime and dispatches pub/sub events", async () => {
    const fake = createFakeZenoh();
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      { importZenoh: async () => fake.runtime, logger: quietLogger },
    );
    const messages: TransportMessage[] = [];
    const presences: TransportPresence[] = [];
    const feedEvents: FeedEvent[] = [];
    transport.onMessage((msg) => messages.push(msg));
    transport.onPresence((presence) => presences.push(presence));
    transport.onFeed((event) => feedEvents.push(event));

    await transport.connect();

    expect(transport.connected).toBe(true);
    expect(fake.openedLocator).toBe("ws://router:10000");
    expect([...fake.subscribers.keys()]).toEqual([
      "maw/*/hey/m5",
      "maw/*/presence",
      "maw/*/feed",
    ]);

    fake.subscribers.get("maw/*/hey/m5")?.(sample({
      from: "white",
      to: "m5",
      body: "hello",
      timestamp: 42,
      transport: "http",
    }));
    fake.subscribers.get("maw/*/hey/m5")?.(badSample());
    fake.subscribers.get("maw/*/presence")?.(sample({
      oracle: "pulse",
      host: "white",
      status: "ready",
      timestamp: 43,
    }));
    fake.subscribers.get("maw/*/presence")?.(badSample());
    fake.subscribers.get("maw/*/feed")?.(sample({
      timestamp: "2026-05-17 08:00:00",
      oracle: "pulse",
      host: "white",
      event: "MessageSend",
      project: "maw-js",
      sessionId: "s1",
      message: "sent",
      ts: 42,
    } satisfies FeedEvent));
    fake.subscribers.get("maw/*/feed")?.(badSample());

    expect(messages).toEqual([expect.objectContaining({
      from: "white",
      to: "m5",
      body: "hello",
      transport: "zenoh",
    })]);
    expect(presences).toEqual([{
      oracle: "pulse",
      host: "white",
      status: "ready",
      timestamp: 43,
    }]);
    expect(feedEvents).toEqual([expect.objectContaining({ event: "MessageSend", message: "sent" })]);
  });

  test("sends messages and publishes presence/feed while connected", async () => {
    const fake = createFakeZenoh();
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      { importZenoh: async () => fake.runtime, now: () => 1234, logger: quietLogger },
    );

    expect(await transport.send({ oracle: "pulse", host: "white" }, "before connect")).toBe(false);
    await transport.publishPresence({ oracle: "mawjs", host: "m5", status: "ready", timestamp: 1 });
    await transport.publishFeed({
      timestamp: "2026-05-17 08:00:00",
      oracle: "mawjs",
      host: "m5",
      event: "MessageSend",
      project: "maw-js",
      sessionId: "s1",
      message: "before connect",
      ts: 1,
    });
    expect(fake.puts).toEqual([]);

    await transport.connect();

    expect(await transport.send({ oracle: "pulse", host: "white" }, "hi")).toBe(true);
    await transport.publishPresence({ oracle: "mawjs", host: "m5", status: "ready", timestamp: 2 });
    await transport.publishFeed({
      timestamp: "2026-05-17 08:01:00",
      oracle: "mawjs",
      host: "m5",
      event: "MessageDeliver",
      project: "maw-js",
      sessionId: "s1",
      message: "delivered",
      ts: 2,
    });

    expect(fake.puts.map((put) => put.topic)).toEqual([
      "maw/m5/hey/pulse",
      "maw/m5/presence",
      "maw/m5/feed",
    ]);
    expect(decode(fake.puts[0].payload)).toEqual({
      from: "m5",
      to: "pulse",
      body: "hi",
      timestamp: 1234,
      transport: "zenoh",
    });
    expect(decode(fake.puts[1].payload)).toEqual({
      oracle: "mawjs",
      host: "m5",
      status: "ready",
      timestamp: 2,
    });
    expect(decode(fake.puts[2].payload)).toEqual(expect.objectContaining({
      event: "MessageDeliver",
      message: "delivered",
    }));
  });

  test("returns false for failed sends and swallows publish failures", async () => {
    const fake = createFakeZenoh({ putFails: true });
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      { importZenoh: async () => fake.runtime, logger: quietLogger },
    );

    await transport.connect();

    expect(await transport.send({ oracle: "pulse", host: "white" }, "hi")).toBe(false);
    await expect(transport.publishPresence({ oracle: "mawjs", host: "m5", status: "ready", timestamp: 1 })).resolves.toBeUndefined();
    await expect(transport.publishFeed({
      timestamp: "2026-05-17 08:01:00",
      oracle: "mawjs",
      host: "m5",
      event: "MessageFail",
      project: "maw-js",
      sessionId: "s1",
      message: "failed",
      ts: 1,
    })).resolves.toBeUndefined();
  });

  test("disconnect cleans up best effort and flips connected state", async () => {
    const fake = createFakeZenoh();
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      { importZenoh: async () => fake.runtime, logger: quietLogger },
    );

    await transport.connect();
    await transport.disconnect();

    expect(transport.connected).toBe(false);
    expect(fake.undeclared).toEqual([
      "sub:maw/*/hey/m5",
      "sub:maw/*/presence",
      "sub:maw/*/feed",
      "token:maw/m5/alive",
    ]);
    expect(fake.closed).toBe(true);

    await transport.disconnect();
    expect(transport.connected).toBe(false);
  });

  test("disconnect keeps going when zenoh cleanup throws", async () => {
    const fake = createFakeZenoh({ undeclareFails: true, closeFails: true });
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      { importZenoh: async () => fake.runtime, logger: quietLogger },
    );

    await transport.connect();
    await expect(transport.disconnect()).resolves.toBeUndefined();

    expect(transport.connected).toBe(false);
  });

  test("reports connect failures without leaving a half-connected transport", async () => {
    const warnings: string[] = [];
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      {
        importZenoh: async () => {
          throw new Error("zenoh bridge missing");
        },
        logger: { log() {}, warn: (msg: string) => warnings.push(msg) },
      },
    );

    await transport.connect();

    expect(transport.connected).toBe(false);
    expect(warnings).toEqual(["[zenoh] connect failed: zenoh bridge missing"]);
  });

  test("canReach only allows non-local targets while connected", async () => {
    const fake = createFakeZenoh();
    const transport = new ZenohTransport(
      { locator: "ws://router:10000", node: "m5" },
      { importZenoh: async () => fake.runtime, logger: quietLogger },
    );

    expect(transport.canReach({ oracle: "pulse", host: "white" })).toBe(false);
    await transport.connect();

    expect(transport.canReach({ oracle: "pulse", host: "white" })).toBe(true);
    expect(transport.canReach({ oracle: "pulse" })).toBe(false);
    expect(transport.canReach({ oracle: "pulse", host: "local" })).toBe(false);
    expect(transport.canReach({ oracle: "pulse", host: "localhost" })).toBe(false);
  });
});
