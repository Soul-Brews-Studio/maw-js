import { afterEach, describe, expect, test } from "bun:test";
import {
  clearEnginePluginRegistrations,
  dispatchEnginePluginEvent,
  findEnginePluginRegistration,
  listEnginePluginRegistrations,
  pollEnginePluginHealth,
  proxyEnginePluginRequest,
  registerEnginePlugin,
} from "../../src/core/engine-plugin-registry";

afterEach(() => clearEnginePluginRegistrations());

describe("engine plugin registry (#1566)", () => {
  test("registers loopback API prefixes and matches the longest prefix", () => {
    const root = registerEnginePlugin({
      plugin: "hey-ledger",
      prefix: "/api/hey-ledger/",
      upstream: "http://127.0.0.1:43210/",
      events: ["MessageSend", "MessageDeliver", "MessageSend"],
      eventPath: "/events",
      health: "/health",
    });
    const nested = registerEnginePlugin({
      plugin: "hey-ledger-admin",
      prefix: "/api/hey-ledger/admin",
      upstream: "http://localhost:43211/internal",
    });

    expect(root.prefix).toBe("/api/hey-ledger");
    expect(root.events).toEqual(["MessageSend", "MessageDeliver"]);
    expect(root.eventPath).toBe("/events");
    expect(listEnginePluginRegistrations().map((r) => r.prefix)).toEqual([
      "/api/hey-ledger",
      "/api/hey-ledger/admin",
    ]);
    expect(findEnginePluginRegistration("/api/hey-ledger/admin/users")?.plugin).toBe(nested.plugin);
    expect(findEnginePluginRegistration("/api/hey-ledger/messages")?.plugin).toBe(root.plugin);
    expect(findEnginePluginRegistration("/api/_engine/register")).toBeUndefined();
  });

  test("rejects unsafe prefixes and non-loopback upstreams", () => {
    expect(() => registerEnginePlugin({ plugin: "Bad", prefix: "/api/bad", upstream: "http://127.0.0.1:1" }))
      .toThrow(/plugin/);
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/bad", upstream: "http://127.0.0.1:1" }))
      .toThrow(/prefix/);
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/api/_engine/bad", upstream: "http://127.0.0.1:1" }))
      .toThrow(/_engine/);
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/api/bad", upstream: "http://example.com:1" }))
      .toThrow(/loopback/);
  });

  test("proxies requests to the registered upstream preserving suffix, query, body, and gateway headers", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        return Response.json({
          method: req.method,
          path: url.pathname,
          query: url.search,
          body,
          plugin: req.headers.get("x-maw-engine-plugin"),
          prefix: req.headers.get("x-forwarded-prefix"),
        });
      },
    });
    try {
      const registration = registerEnginePlugin({
        plugin: "hey-ledger",
        prefix: "/api/hey-ledger",
        upstream: `http://127.0.0.1:${upstream.port}/internal`,
      });

      const response = await proxyEnginePluginRequest(
        new Request("http://maw.local/api/hey-ledger/items?q=1", {
          method: "POST",
          body: "hello",
          headers: { "content-type": "text/plain" },
        }),
        registration,
      );
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(response.headers.get("x-maw-engine-plugin")).toBe("hey-ledger");
      expect(body).toMatchObject({
        method: "POST",
        path: "/internal/items",
        query: "?q=1",
        body: "hello",
        plugin: "hey-ledger",
        prefix: "/api/hey-ledger",
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("delivers subscribed feed events to plugin-owned event endpoints", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({
          path: url.pathname,
          plugin: req.headers.get("x-maw-engine-plugin"),
          prefix: req.headers.get("x-forwarded-prefix"),
          body: await req.json(),
        });
        return Response.json({ ok: true });
      },
    });
    try {
      registerEnginePlugin({
        plugin: "hey-ledger",
        prefix: "/api/hey-ledger",
        upstream: `http://127.0.0.1:${upstream.port}/engine`,
        events: ["MessageSend"],
        eventPath: "/events",
      });

      const ignored = await dispatchEnginePluginEvent({
        timestamp: "2026-05-16T01:02:02.000Z",
        oracle: "mawjs-codex",
        host: "m5",
        event: "Notification",
        project: "",
        sessionId: "",
        message: "ignored",
        ts: Date.now(),
      });
      const delivered = await dispatchEnginePluginEvent({
        timestamp: "2026-05-16T01:02:03.000Z",
        oracle: "mawjs-codex",
        host: "m5",
        event: "MessageSend",
        project: "",
        sessionId: "",
        message: "hello",
        ts: Date.now(),
        data: { id: "m1", text: "hello" },
      });

      expect(ignored).toEqual({ delivered: 0, failed: 0, removed: 0 });
      expect(delivered).toEqual({ delivered: 1, failed: 0, removed: 0 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        path: "/engine/events",
        plugin: "hey-ledger",
        prefix: "/api/hey-ledger",
      });
      expect(seen[0].body).toMatchObject({ event: "MessageSend", message: "hello", data: { id: "m1" } });
    } finally {
      upstream.stop(true);
    }
  });

  test("event delivery connection failures unbind crashed plugin engines", async () => {
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
    registerEnginePlugin({
      plugin: "event-crashy",
      prefix: "/api/event-crashy",
      upstream: `http://127.0.0.1:${upstream.port}`,
      events: ["MessageDeliver"],
    });
    upstream.stop(true);

    const result = await dispatchEnginePluginEvent({
      timestamp: "2026-05-16T01:02:04.000Z",
      oracle: "mawjs-oracle",
      host: "m5",
      event: "MessageDeliver",
      project: "",
      sessionId: "",
      message: "inbound",
      ts: Date.now(),
    });

    expect(result).toEqual({ delivered: 0, failed: 1, removed: 1 });
    expect(findEnginePluginRegistration("/api/event-crashy/messages")).toBeUndefined();
  });

  test("unregisters crashed upstreams and returns a 503", async () => {
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
    const registration = registerEnginePlugin({
      plugin: "crashy",
      prefix: "/api/crashy",
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    upstream.stop(true);

    const response = await proxyEnginePluginRequest(new Request("http://maw.local/api/crashy/ping"), registration);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, error: "engine_plugin_unavailable", plugin: "crashy" });
    expect(findEnginePluginRegistration("/api/crashy/ping")).toBeUndefined();
  });

  test("health polling removes dead registered plugin processes before the next request", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new URL(req.url).pathname === "/health"
        ? Response.json({ ok: true })
        : Response.json({ ok: true }),
    });
    const registration = registerEnginePlugin({
      plugin: "health-ledger",
      prefix: "/api/health-ledger",
      upstream: `http://127.0.0.1:${upstream.port}`,
      health: "/health",
    });

    expect(await pollEnginePluginHealth()).toEqual({ checked: 1, removed: 0 });
    expect(findEnginePluginRegistration("/api/health-ledger/messages")).toBe(registration);

    upstream.stop(true);
    expect(await pollEnginePluginHealth()).toEqual({ checked: 1, removed: 1 });
    expect(findEnginePluginRegistration("/api/health-ledger/messages")).toBeUndefined();
  });
});
