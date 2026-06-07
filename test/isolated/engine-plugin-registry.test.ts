import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearEnginePluginRegistrations,
  dispatchEnginePluginEvent,
  findEnginePluginRegistration,
  hasEnginePluginEventSink,
  listEnginePluginRegistrations,
  pollEnginePluginHealth,
  proxyEnginePluginRequest,
  registerEnginePlugin,
  startEnginePluginHealthPolling,
} from "../../src/core/engine-plugin-registry";

afterEach(() => clearEnginePluginRegistrations());

function unixSocketPath(name = "plugin.sock"): { dir: string; socket: string } {
  const dir = mkdtempSync(join(tmpdir(), "maw-engine-unix-"));
  return { dir, socket: join(dir, name) };
}

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

  test("reports active event sinks by plugin and event", () => {
    expect(hasEnginePluginEventSink("messages", "MessageSend")).toBe(false);
    registerEnginePlugin({
      plugin: "messages",
      prefix: "/api/message-ledger",
      upstream: "http://127.0.0.1:43210",
      events: ["MessageSend", "MessageDeliver"],
      eventPath: "/events",
    });

    expect(hasEnginePluginEventSink("messages", "MessageSend")).toBe(true);
    expect(hasEnginePluginEventSink("messages", "MessageFail")).toBe(false);
    expect(hasEnginePluginEventSink("other", "MessageSend")).toBe(false);
    expect(hasEnginePluginEventSink(undefined, "MessageSend")).toBe(false);
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
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/api/bad", upstream: "unix://localhost/tmp/maw.sock" }))
      .toThrow(/unix upstream/);
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/api/bad", upstream: "unix:///var/run/docker.sock" }))
      .toThrow(/tmpdir|MAW_HOME/);
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/api/bad", upstream: "unix:///tmp/%2e%2e/var/run/maw.sock" }))
      .toThrow(/traversal/);
    expect(() => registerEnginePlugin({ plugin: "bad", prefix: "/api/bad", upstream: "unix:///tmp/maw-engine" }))
      .toThrow(/\.sock/);
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

  test("health polling timer auto-prunes dead registered plugin processes", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true }),
    });
    registerEnginePlugin({
      plugin: "timer-ledger",
      prefix: "/api/timer-ledger",
      upstream: `http://127.0.0.1:${upstream.port}`,
      health: "/health",
    });

    const stopPolling = startEnginePluginHealthPolling(5);
    try {
      upstream.stop(true);
      for (let i = 0; i < 20 && findEnginePluginRegistration("/api/timer-ledger/messages"); i++) {
        await Bun.sleep(10);
      }
      expect(findEnginePluginRegistration("/api/timer-ledger/messages")).toBeUndefined();
    } finally {
      stopPolling();
    }
  });

  test("proxies requests to unix upstreams preserving suffix, query, body, and headers", async () => {
    const { dir, socket } = unixSocketPath();
    const upstream = Bun.serve({
      unix: socket,
      async fetch(req) {
        const url = new URL(req.url);
        return Response.json({
          method: req.method,
          path: url.pathname,
          query: url.search,
          body: await req.text(),
          plugin: req.headers.get("x-maw-engine-plugin"),
          prefix: req.headers.get("x-forwarded-prefix"),
        });
      },
    });
    try {
      const registration = registerEnginePlugin({
        plugin: "unix-ledger",
        prefix: "/api/unix-ledger",
        upstream: `unix://${socket}`,
      });

      const response = await proxyEnginePluginRequest(
        new Request("http://maw.local/api/unix-ledger/items?q=1", {
          method: "POST",
          body: "hello unix",
          headers: { "content-type": "text/plain" },
        }),
        registration,
      );
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(registration.upstream).toBe(`unix://${socket}`);
      expect(body).toMatchObject({
        method: "POST",
        path: "/items",
        query: "?q=1",
        body: "hello unix",
        plugin: "unix-ledger",
        prefix: "/api/unix-ledger",
      });
    } finally {
      upstream.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("health polling works for unix upstreams", async () => {
    const { dir, socket } = unixSocketPath();
    const upstream = Bun.serve({
      unix: socket,
      fetch: (req) => new URL(req.url).pathname === "/health"
        ? Response.json({ ok: true })
        : Response.json({ ok: false }, { status: 404 }),
    });
    try {
      const registration = registerEnginePlugin({
        plugin: "unix-health",
        prefix: "/api/unix-health",
        upstream: `unix://${socket}`,
        health: "/health",
      });

      expect(await pollEnginePluginHealth()).toEqual({ checked: 1, removed: 0 });
      expect(findEnginePluginRegistration("/api/unix-health/messages")).toBe(registration);
    } finally {
      upstream.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("event delivery works for unix upstreams", async () => {
    const { dir, socket } = unixSocketPath();
    const seen: Array<Record<string, unknown>> = [];
    const upstream = Bun.serve({
      unix: socket,
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
        plugin: "unix-events",
        prefix: "/api/unix-events",
        upstream: `unix://${socket}`,
        events: ["MessageSend"],
        eventPath: "/events",
      });

      const delivered = await dispatchEnginePluginEvent({
        timestamp: "2026-05-16T01:02:03.000Z",
        oracle: "mawjs-codex",
        host: "m5",
        event: "MessageSend",
        project: "",
        sessionId: "",
        message: "hello unix",
        ts: Date.now(),
        data: { id: "unix-m1", text: "hello unix" },
      });

      expect(delivered).toEqual({ delivered: 1, failed: 0, removed: 0 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        path: "/events",
        plugin: "unix-events",
        prefix: "/api/unix-events",
      });
      expect(seen[0].body).toMatchObject({ event: "MessageSend", message: "hello unix" });
    } finally {
      upstream.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unix upstream crashes unbind and return 503", async () => {
    const { dir, socket } = unixSocketPath();
    const upstream = Bun.serve({ unix: socket, fetch: () => Response.json({ ok: true }) });
    const registration = registerEnginePlugin({
      plugin: "unix-crashy",
      prefix: "/api/unix-crashy",
      upstream: `unix://${socket}`,
    });
    upstream.stop(true);
    rmSync(dir, { recursive: true, force: true });

    const response = await proxyEnginePluginRequest(new Request("http://maw.local/api/unix-crashy/ping"), registration);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ ok: false, error: "engine_plugin_unavailable", plugin: "unix-crashy" });
    expect(findEnginePluginRegistration("/api/unix-crashy/ping")).toBeUndefined();
  });
});
