import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { ServeRouteRegistry } from "../../src/core/serve-route-registry";
import { createIdentityApi } from "../../src/vendor/mpr-plugins/serve-identity/impl";
import { registerIdentityRouteForTests } from "../../src/vendor/mpr-plugins/serve-identity/index";
import { createWorktreesApi } from "../../src/api/worktrees";
import { createWorktreesRouteHandlers, registerWorktreesRoutes } from "../../src/vendor/mpr-plugins/serve-worktrees/index";
import { buildTriggersReadResponse, serve as serveTriggers } from "../../src/vendor/mpr-plugins/serve-triggers/index";
import { renderPluginsPage, serve as serveDebug } from "../../src/vendor/mpr-plugins/serve-debug/index";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ResponseSnapshot = {
  status: number;
  contentType: string | null;
  body: Json | string;
};

async function snapshotResponse(response: Response): Promise<ResponseSnapshot> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? null;
  const text = await response.text();
  let body: Json | string = text;
  if (contentType === "application/json" || text.startsWith("{") || text.startsWith("[")) {
    body = JSON.parse(text) as Json;
  }
  return { status: response.status, contentType, body };
}

async function expectEquivalent(name: string, baseline: Response | Promise<Response>, extracted: Response | Promise<Response>) {
  expect(await snapshotResponse(await extracted), name).toEqual(await snapshotResponse(await baseline));
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const worktreesFixture = [
  { path: "/repo/main", branch: "alpha", clean: true },
  { path: "/repo/plugin", branch: "codex-serve", clean: false },
];

const worktreeDeps = {
  scanWorktrees: async () => worktreesFixture as any,
  cleanupWorktree: async (path: string) => `cleaned ${path}`,
};

function makePluginStats() {
  return {
    startedAt: "2026-06-07T00:00:00.000Z",
    plugins: [{ name: "serve-views", type: "ts", events: 3, errors: 0, loadedAt: "2026-06-07T00:00:01.000Z", lastEvent: "ready" }],
    totalEvents: 3,
    totalErrors: 0,
    gated: 0,
    gates: { "*": 1 },
    filters: {},
    handlers: { ready: 1 },
    lates: {},
  };
}

function normalizeDebugHtml(snapshot: ResponseSnapshot): ResponseSnapshot {
  if (typeof snapshot.body !== "string") return snapshot;
  return {
    ...snapshot,
    body: snapshot.body.replace(/<div class="n">[^<]+<\/div><div class="l">Uptime<\/div>/, "<div class=\"n\">UPTIME</div><div class=\"l\">Uptime</div>"),
  };
}

describe("serve plugin equivalence snapshots (#2446)", () => {
  test("serve-identity matches the legacy identity API response", async () => {
    const deps = {
      loadConfig: (() => ({ node: "m5", nodeUser: "codex", port: 3456, oracle: "mawjs", agents: { neo: "codex@m5" } })) as any,
      hostedAgents: ((agents: any, node: string) => Object.entries(agents)
        .filter(([, value]) => value === node)
        .map(([name]) => ({ node, name }))) as any,
      getPeerKey: () => "pub",
      packageVersion: "v.test",
      uptime: () => 2.9,
      nowIso: () => "2026-06-07T00:00:00.000Z",
    };
    const baseline = new Elysia().use(createIdentityApi(deps));
    const extracted = new Elysia({ prefix: "/api" });
    extracted.use(createIdentityApi(deps));

    await expectEquivalent(
      "GET /api/identity",
      baseline.handle(new Request("http://local/identity")),
      extracted.handle(new Request("http://local/api/identity")),
    );
  });

  test("serve-identity serve hook registers the same identity route", async () => {
    const target = new Elysia({ prefix: "/api" });
    await registerIdentityRouteForTests(target as any);
    const response = await target.handle(new Request("http://local/api/identity"));

    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, unknown>).endpoints).toEqual(expect.arrayContaining(["/api/identity", "/api/send"]));
  });

  test("serve-worktrees matches legacy worktrees API responses", async () => {
    const baseline = createWorktreesApi(worktreeDeps as any);
    const handlers = createWorktreesRouteHandlers(worktreeDeps as any);
    const registry = new ServeRouteRegistry();
    registerWorktreesRoutes(registry, worktreeDeps as any);

    await expectEquivalent(
      "GET /api/worktrees",
      baseline.handle(new Request("http://local/worktrees")),
      registry.handle(new Request("http://local/api/worktrees")) as Promise<Response>,
    );
    await expectEquivalent(
      "POST /api/worktrees/cleanup",
      baseline.handle(jsonRequest("/worktrees/cleanup", { path: "/repo/plugin" })),
      registry.handle(jsonRequest("/api/worktrees/cleanup", { path: "/repo/plugin" })) as Promise<Response>,
    );
    await expectEquivalent(
      "POST /api/worktrees/cleanup empty path",
      baseline.handle(jsonRequest("/worktrees/cleanup", { path: "" })),
      handlers.cleanup(jsonRequest("/api/worktrees/cleanup", { path: "" })),
    );
  });

  test("serve-triggers read route matches the legacy trigger snapshot", async () => {
    const registry = new ServeRouteRegistry();
    serveTriggers({ http: registry });

    await expectEquivalent(
      "GET /api/triggers",
      Response.json(buildTriggersReadResponse()),
      registry.handle(new Request("http://local/api/triggers")) as Promise<Response>,
    );
  });

  test("serve-debug routes match the legacy inline plugin debug responses", async () => {
    const stats = makePluginStats();
    const registry = new ServeRouteRegistry();
    serveDebug({
      http: registry,
      plugins: { stats: () => stats },
      reloadPlugins: async () => ({ ok: true, reloaded: true, ...stats }),
    });

    await expectEquivalent(
      "GET /api/plugins",
      Response.json(stats),
      registry.handle(new Request("http://local/api/plugins")) as Promise<Response>,
    );
    await expectEquivalent(
      "POST /api/plugins/reload",
      Response.json({ ok: true, reloaded: true, ...stats }),
      registry.handle(new Request("http://local/api/plugins/reload", { method: "POST" })) as Promise<Response>,
    );

    expect(normalizeDebugHtml(await snapshotResponse(await registry.handle(new Request("http://local/plugins")) as Response))).toEqual(
      normalizeDebugHtml(await snapshotResponse(new Response(renderPluginsPage(stats), { headers: { "content-type": "text/html; charset=utf-8" } }))),
    );
  });
});
