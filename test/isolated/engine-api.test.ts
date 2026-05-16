import { afterEach, describe, expect, test } from "bun:test";
import { engineApi } from "../../src/api/engine";
import { clearEnginePluginRegistrations, listEnginePluginRegistrations } from "../../src/core/engine-plugin-registry";

afterEach(() => clearEnginePluginRegistrations());

describe("dynamic engine API (#1566)", () => {
  test("registers, lists, and unregisters engine plugin routes", async () => {
    const register = await engineApi.handle(new Request("http://maw.local/_engine/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plugin: "hey-ledger",
        prefix: "/api/hey-ledger",
        upstream: "http://127.0.0.1:45678",
        events: ["MessageSend"],
        eventPath: "/events",
        health: "/health",
      }),
    }));
    const registered = await register.json() as Record<string, any>;

    expect(register.status).toBe(201);
    expect(registered.ok).toBe(true);
    expect(registered.registration.prefix).toBe("/api/hey-ledger");
    expect(registered.registration.eventPath).toBe("/events");

    const list = await engineApi.handle(new Request("http://maw.local/_engine/registrations"));
    const listed = await list.json() as Record<string, any>;
    expect(listed.registrations).toHaveLength(1);

    const unregister = await engineApi.handle(new Request("http://maw.local/_engine/unregister", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plugin: "hey-ledger" }),
    }));
    const unregistered = await unregister.json() as Record<string, any>;
    expect(unregistered).toMatchObject({ ok: true, removed: true });
    expect(listEnginePluginRegistrations()).toEqual([]);
  });

  test("bad registrations return 400 instead of binding unsafe routes", async () => {
    const response = await engineApi.handle(new Request("http://maw.local/_engine/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plugin: "bad", prefix: "/api/bad", upstream: "http://example.com" }),
    }));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(listEnginePluginRegistrations()).toEqual([]);
  });
});
