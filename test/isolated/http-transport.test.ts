import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../../src/lib/feed";
import type { Session } from "../../src/core/runtime/find-window";
import { HttpTransport } from "../../src/transports/http";

function event(): FeedEvent {
  return {
    timestamp: "2026-05-17 00:00:00",
    oracle: "mawjs",
    host: "m5",
    event: "MessageSend",
    project: "maw-js",
    sessionId: "test",
    message: "hello",
    ts: 1,
  };
}

function session(name: string, windowName: string, source?: string): Session & { source?: string } {
  return {
    name,
    source,
    windows: [{ index: 0, name: windowName, active: true }],
  };
}

describe("HttpTransport", () => {
  test("connects only when peers are configured", async () => {
    const offline = new HttpTransport({ peers: [], selfHost: "local" });
    expect(offline.name).toBe("http-federation");
    expect(offline.connected).toBe(false);
    await offline.connect();
    expect(offline.connected).toBe(false);

    const online = new HttpTransport({ peers: ["http://peer"], selfHost: "local" });
    await online.connect();
    expect(online.connected).toBe(true);
    await online.disconnect();
    expect(online.connected).toBe(false);
  });

  test("can reach only remote targets when peers exist", () => {
    const noPeers = new HttpTransport({ peers: [], selfHost: "local" });
    expect(noPeers.canReach({ oracle: "mawjs", host: "m5" })).toBe(false);

    const transport = new HttpTransport({ peers: ["http://peer"], selfHost: "local" });
    expect(transport.canReach({ oracle: "mawjs" })).toBe(false);
    expect(transport.canReach({ oracle: "mawjs", host: "local" })).toBe(false);
    expect(transport.canReach({ oracle: "mawjs", host: "localhost" })).toBe(false);
    expect(transport.canReach({ oracle: "mawjs", host: "m5" })).toBe(true);
  });

  test("sends through the peer that owns a matching remote window", async () => {
    const localSessions = [session("local", "local-oracle")];
    const allSessions = [
      session("local", "local-oracle", "local"),
      session("remote-a", "other-oracle", "http://peer-a"),
      session("remote-b", "target-oracle", "http://peer-b"),
    ];
    const sent: Array<{ source: string; target: string; message: string }> = [];
    const transport = new HttpTransport(
      { peers: ["http://peer-a", "http://peer-b"], selfHost: "local" },
      {
        listLocalSessions: async () => localSessions,
        getAllSessions: async (sessions) => {
          expect(sessions).toBe(localSessions);
          return allSessions;
        },
        findTargetWindow: (sessions, query) => {
          expect(sessions).toEqual([allSessions[2]]);
          expect(query).toBe("target");
          return "remote-b:0";
        },
        sendPeerKeys: async (source, target, message) => {
          sent.push({ source, target, message });
          return true;
        },
      },
    );

    expect(await transport.send({ oracle: "target", host: "remote" }, "hello")).toBe(true);
    expect(sent).toEqual([{ source: "http://peer-b", target: "remote-b:0", message: "hello" }]);
  });

  test("returns false when no remote session resolves to a tmux target", async () => {
    const transport = new HttpTransport(
      { peers: ["http://peer"], selfHost: "local" },
      {
        listLocalSessions: async () => [],
        getAllSessions: async () => [
          session("local", "target-oracle"),
          session("remote-a", "other-oracle", "http://peer-a"),
          session("remote-b", "target-oracle", "http://peer-b"),
        ],
        findTargetWindow: () => null,
        sendPeerKeys: async () => {
          throw new Error("send should not run without tmux target");
        },
      },
    );

    expect(await transport.send({ oracle: "target", host: "remote" }, "hello")).toBe(false);
  });

  test("publishes feed events to every peer and warns on rejected publishes", async () => {
    const calls: Array<{ url: string; method?: string; body?: string; timeout?: number }> = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const transport = new HttpTransport(
        { peers: ["http://a", "http://b", "http://c"], selfHost: "local" },
        {
          timeoutFor: () => 1234,
          postPeerFeed: async (url, opts) => {
            calls.push({ url, method: opts?.method, body: opts?.body, timeout: opts?.timeout });
            if (url === "http://b/api/feed") throw new Error("boom");
            return { ok: true, status: 200, data: { ok: true } };
          },
        },
      );

      const feed = event();
      await transport.publishFeed(feed);

      expect(calls).toEqual([
        { url: "http://a/api/feed", method: "POST", body: JSON.stringify(feed), timeout: 1234 },
        { url: "http://b/api/feed", method: "POST", body: JSON.stringify(feed), timeout: 1234 },
        { url: "http://c/api/feed", method: "POST", body: JSON.stringify(feed), timeout: 1234 },
      ]);
      expect(warnings.join("\n")).toContain("feed publish failed for http://b: boom");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("accepts handlers and ignores HTTP presence", async () => {
    const transport = new HttpTransport({ peers: [], selfHost: "local" });

    transport.onMessage(() => {});
    transport.onPresence(() => {});
    transport.onFeed(() => {});

    await expect(transport.publishPresence({
      oracle: "mawjs",
      host: "m5",
      status: "ready",
      timestamp: 1,
    })).resolves.toBeUndefined();
  });
});
