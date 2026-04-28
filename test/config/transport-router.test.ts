/**
 * Tests for src/core/transport/transport.ts — TransportRouter class.
 * Pure routing logic with mock transports (no real network/tmux).
 */
import { describe, it, expect } from "bun:test";
import { TransportRouter } from "../../src/core/transport/transport";
import type { Transport, TransportTarget, TransportPresence, TransportMessage } from "../../src/core/transport/transport";
import type { FeedEvent } from "../../src/lib/feed";

/** Minimal mock transport */
function mockTransport(name: string, opts: {
  connected?: boolean;
  canReach?: boolean;
  sendResult?: boolean;
  sendThrows?: Error;
} = {}): Transport {
  const { connected = true, canReach: reach = true, sendResult = true, sendThrows } = opts;
  const msgHandlers: Array<(msg: TransportMessage) => void> = [];
  const presHandlers: Array<(p: TransportPresence) => void> = [];
  const feedHandlers: Array<(e: FeedEvent) => void> = [];

  return {
    name,
    connected,
    connect: async () => {},
    disconnect: async () => {},
    send: async (_target, _message) => {
      if (sendThrows) throw sendThrows;
      return sendResult;
    },
    publishPresence: async () => {},
    publishFeed: async () => {},
    onMessage: (h) => { msgHandlers.push(h); },
    onPresence: (h) => { presHandlers.push(h); },
    onFeed: (h) => { feedHandlers.push(h); },
    canReach: () => reach,
  };
}

describe("TransportRouter", () => {
  it("sends via first matching transport", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux"));
    router.register(mockTransport("http"));

    const result = await router.send(
      { oracle: "neo" },
      "hello",
      "pim",
    );
    expect(result.ok).toBe(true);
    expect(result.via).toBe("tmux");
  });

  it("falls through to next transport on failure", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { sendResult: false }));
    router.register(mockTransport("http", { sendResult: true }));

    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(true);
    expect(result.via).toBe("http");
  });

  it("falls through on retryable error", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { sendThrows: new Error("ECONNREFUSED") }));
    router.register(mockTransport("http"));

    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(true);
    expect(result.via).toBe("http");
  });

  it("stops on non-retryable error", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { sendThrows: new Error("401 Unauthorized") }));
    router.register(mockTransport("http"));

    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(false);
    expect(result.via).toBe("tmux");
    expect(result.reason).toBe("auth");
  });

  it("skips disconnected transports", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { connected: false }));
    router.register(mockTransport("http"));

    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(true);
    expect(result.via).toBe("http");
  });

  it("skips transports that can't reach target", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { canReach: false }));
    router.register(mockTransport("http"));

    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(true);
    expect(result.via).toBe("http");
  });

  it("returns unreachable when no transport works", async () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { canReach: false }));

    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unreachable");
  });

  it("returns status of all transports", () => {
    const router = new TransportRouter();
    router.register(mockTransport("tmux", { connected: true }));
    router.register(mockTransport("mqtt", { connected: false }));

    const status = router.status();
    expect(status).toEqual([
      { name: "tmux", connected: true },
      { name: "mqtt", connected: false },
    ]);
  });

  it("works with no transports registered", async () => {
    const router = new TransportRouter();
    const result = await router.send({ oracle: "neo" }, "hi", "pim");
    expect(result.ok).toBe(false);
  });
});
