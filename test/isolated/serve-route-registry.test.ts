import { describe, expect, test } from "bun:test";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";

describe("ServeRouteRegistry", () => {
  test("dispatches exact registered method/path before returning undefined", async () => {
    const registry = new ServeRouteRegistry();
    registry.route("GET", "/api/worktrees", () => Response.json({ ok: true, route: "worktrees" }));
    registry.route("GET", "/api/triggers", () => Response.json({ ok: true, route: "triggers" }));
    registry.route("POST", "/api/triggers/fire", () => Response.json({ ok: true, route: "triggers-fire" }));

    const worktrees = await registry.handle(new Request("http://local/api/worktrees?ignored=1"));
    expect(worktrees?.status).toBe(200);
    expect(await worktrees!.json()).toEqual({ ok: true, route: "worktrees" });

    const triggers = await registry.handle(new Request("http://local/api/triggers?ignored=1"));
    expect(triggers?.status).toBe(200);
    expect(await triggers!.json()).toEqual({ ok: true, route: "triggers" });

    const fire = await registry.handle(new Request("http://local/api/triggers/fire", { method: "POST" }));
    expect(fire?.status).toBe(200);
    expect(await fire!.json()).toEqual({ ok: true, route: "triggers-fire" });

    expect(await registry.handle(new Request("http://local/api/worktrees", { method: "POST" }))).toBeUndefined();
    expect(await registry.handle(new Request("http://local/api/triggers/extra"))).toBeUndefined();
    expect(await registry.handle(new Request("http://local/api/other"))).toBeUndefined();
    expect(registry.snapshot()).toEqual([
      { method: "GET", path: "/api/worktrees" },
      { method: "GET", path: "/api/triggers" },
      { method: "POST", path: "/api/triggers/fire" },
    ]);
  });

  test("dispatches colon parameter routes after exact routes", async () => {
    const registry = new ServeRouteRegistry();
    registry.route("GET", "/api/status", () => Response.json({ route: "summary" }));
    registry.route("GET", "/api/status/:oracle", (request) => {
      const oracle = new URL(request.url).pathname.split("/").pop();
      return Response.json({ route: "oracle", oracle });
    });

    const exact = await registry.handle(new Request("http://local/api/status"));
    expect(await exact!.json()).toEqual({ route: "summary" });

    const param = await registry.handle(new Request("http://local/api/status/neo"));
    expect(await param!.json()).toEqual({ route: "oracle", oracle: "neo" });

    expect(await registry.handle(new Request("http://local/api/status/neo/extra"))).toBeUndefined();
  });

  test("rejects non-absolute paths, invalid handlers, and duplicate routes", () => {
    const registry = new ServeRouteRegistry();
    expect(() => registry.route("GET", "api/worktrees", () => new Response())).toThrow("serve route path must start");
    expect(() => registry.route("GET", "/api/bad", undefined as never)).toThrow("serve route GET /api/bad handler must be a function");
    registry.route("GET", "/api/worktrees", () => new Response());
    expect(() => registry.route("get" as any, "/api/worktrees", () => new Response())).toThrow("serve route already registered");
    registry.route("GET", "/api/triggers", () => new Response());
    expect(() => registry.route("GET", "/api/triggers", () => new Response())).toThrow("serve route already registered: GET /api/triggers");
  });

  test("scopes route and fallback ownership to the registering plugin", async () => {
    const registry = new ServeRouteRegistry();
    const identity = registry.forPlugin({ name: "serve-identity", dir: "/plugins/identity" });
    const views = registry.forPlugin({ name: "serve-views" });

    identity.route("GET", "/api/identity", () => Response.json({ node: "m5" }));
    views.fallback("serve-views", () => new Response("view"));

    expect(registry.snapshot()).toEqual([{ method: "GET", path: "/api/identity", plugin: "serve-identity" }]);
    expect(registry.fallbackSnapshot()).toEqual([{ id: "serve-views", plugin: "serve-views" }]);
    expect(await (await registry.handle(new Request("http://local/api/identity")))!.json()).toEqual({ node: "m5" });
    expect(await (await registry.handleFallback(new Request("http://local/"))).text()).toBe("view");

    expect(() => registry.forPlugin({ name: "" })).toThrow("serve route plugin name is required");
    expect(() => registry.forPlugin({ name: "serve-debug" }).route("GET", "/api/identity", () => new Response()))
      .toThrow("serve route already registered: GET /api/identity (serve-identity)");
    expect(() => registry.forPlugin({ name: "other-views" }).fallback("serve-views", () => new Response()))
      .toThrow("serve fallback already registered: serve-views (serve-views)");
  });

  test("dispatches the registered fallback in registration order", async () => {
    const registry = new ServeRouteRegistry();
    registry.fallback("first", () => new Response("first"));
    registry.fallback("second", () => new Response("second"));

    expect(registry.listFallbacks()).toEqual(["first", "second"]);
    expect(await (await registry.handleFallback(new Request("http://local/path"))).text()).toBe("first");
  });

  test("rejects invalid or duplicate fallback registrations", () => {
    const registry = new ServeRouteRegistry();
    expect(() => registry.fallback("", () => new Response())).toThrow("serve fallback id is required");
    registry.fallback("views", () => new Response("ok"));
    expect(() => registry.fallback("views", () => new Response("again"))).toThrow("serve fallback already registered: views");
    expect(() => registry.fallback("bad", undefined as never)).toThrow("serve fallback bad handler must be a function");
  });

  test("returns a core 404 when no fallback is registered", async () => {
    const registry = new ServeRouteRegistry();
    const response = await registry.handleFallback(new Request("http://local/missing"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});
