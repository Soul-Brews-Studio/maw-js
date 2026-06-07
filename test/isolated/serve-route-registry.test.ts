import { describe, expect, test } from "bun:test";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";

describe("ServeRouteRegistry", () => {
  test("dispatches exact registered method/path before returning undefined", async () => {
    const registry = new ServeRouteRegistry();
    registry.route("GET", "/api/worktrees", () => Response.json({ ok: true }));

    const hit = await registry.handle(new Request("http://local/api/worktrees?ignored=1"));
    expect(hit?.status).toBe(200);
    expect(await hit!.json()).toEqual({ ok: true });

    expect(await registry.handle(new Request("http://local/api/worktrees", { method: "POST" }))).toBeUndefined();
    expect(await registry.handle(new Request("http://local/api/other"))).toBeUndefined();
    expect(registry.snapshot()).toEqual([{ method: "GET", path: "/api/worktrees" }]);
  });

  test("rejects non-absolute paths and duplicate routes", () => {
    const registry = new ServeRouteRegistry();
    expect(() => registry.route("GET", "api/worktrees", () => new Response())).toThrow("serve route path must start");
    registry.route("GET", "/api/worktrees", () => new Response());
    expect(() => registry.route("get" as any, "/api/worktrees", () => new Response())).toThrow("serve route already registered");
  });
});
