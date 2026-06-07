import { describe, expect, test } from "bun:test";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";

describe("ServeRouteRegistry", () => {
  test("dispatches exact registered method/path before returning undefined", async () => {
    const registry = new ServeRouteRegistry();
    registry.route("GET", "/api/worktrees", () => Response.json({ ok: true, route: "worktrees" }));
    registry.route("GET", "/api/triggers", () => Response.json({ ok: true, route: "triggers" }));

    const worktrees = await registry.handle(new Request("http://local/api/worktrees?ignored=1"));
    expect(worktrees?.status).toBe(200);
    expect(await worktrees!.json()).toEqual({ ok: true, route: "worktrees" });

    const triggers = await registry.handle(new Request("http://local/api/triggers?ignored=1"));
    expect(triggers?.status).toBe(200);
    expect(await triggers!.json()).toEqual({ ok: true, route: "triggers" });

    expect(await registry.handle(new Request("http://local/api/worktrees", { method: "POST" }))).toBeUndefined();
    expect(await registry.handle(new Request("http://local/api/triggers/extra"))).toBeUndefined();
    expect(await registry.handle(new Request("http://local/api/other"))).toBeUndefined();
    expect(registry.snapshot()).toEqual([
      { method: "GET", path: "/api/worktrees" },
      { method: "GET", path: "/api/triggers" },
    ]);
  });

  test("rejects non-absolute paths and duplicate routes", () => {
    const registry = new ServeRouteRegistry();
    expect(() => registry.route("GET", "api/worktrees", () => new Response())).toThrow("serve route path must start");
    registry.route("GET", "/api/worktrees", () => new Response());
    expect(() => registry.route("get" as any, "/api/worktrees", () => new Response())).toThrow("serve route already registered");
    registry.route("GET", "/api/triggers", () => new Response());
    expect(() => registry.route("GET", "/api/triggers", () => new Response())).toThrow("serve route already registered: GET /api/triggers");
  });
});
