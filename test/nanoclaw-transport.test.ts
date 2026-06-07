import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../src/lib/feed";
import { NanoclawTransport } from "../src/transports/nanoclaw";

describe("NanoclawTransport", () => {
  test("tracks stateless HTTP lifecycle", async () => {
    const transport = new NanoclawTransport();

    expect(transport.name).toBe("nanoclaw");
    expect(transport.connected).toBe(true);

    await transport.disconnect();
    expect(transport.connected).toBe(false);

    await transport.connect();
    expect(transport.connected).toBe(true);
  });

  test("does not send when the target cannot resolve", async () => {
    let sendCalls = 0;
    const transport = new NanoclawTransport(
      () => null,
      async () => {
        sendCalls += 1;
        return true;
      },
    );

    expect(transport.canReach({ oracle: "missing" })).toBe(false);
    expect(await transport.send({ oracle: "missing" }, "hello")).toBe(false);
    expect(sendCalls).toBe(0);
  });

  test("delegates resolved targets to the nanoclaw sender", async () => {
    const sends: Array<{ jid: string; text: string; url: string }> = [];
    const transport = new NanoclawTransport(
      (oracle) => oracle === "nat" ? { jid: "tg:12345", url: "http://nanoclaw.local" } : null,
      async (jid, text, url) => {
        sends.push({ jid, text, url });
        return text === "delivered";
      },
    );

    expect(transport.canReach({ oracle: "nat" })).toBe(true);
    expect(transport.canReach({ oracle: "ghost" })).toBe(false);

    expect(await transport.send({ oracle: "nat" }, "delivered")).toBe(true);
    expect(await transport.send({ oracle: "nat" }, "rejected")).toBe(false);
    expect(sends).toEqual([
      { jid: "tg:12345", text: "delivered", url: "http://nanoclaw.local" },
      { jid: "tg:12345", text: "rejected", url: "http://nanoclaw.local" },
    ]);
  });

  test("accepts handlers and ignores publish-only hooks", async () => {
    const transport = new NanoclawTransport();

    transport.onMessage(() => {});
    transport.onPresence(() => {});
    transport.onFeed(() => {});

    await expect(transport.publishPresence({
      oracle: "mawjs",
      host: "m5",
      status: "ready",
      timestamp: 1,
    })).resolves.toBeUndefined();

    const event: FeedEvent = {
      timestamp: "2026-05-17 00:00:00",
      oracle: "mawjs",
      host: "m5",
      event: "MessageSend",
      project: "maw-js",
      sessionId: "test",
      message: "hello",
      ts: 1,
    };
    await expect(transport.publishFeed(event)).resolves.toBeUndefined();
  });
});
