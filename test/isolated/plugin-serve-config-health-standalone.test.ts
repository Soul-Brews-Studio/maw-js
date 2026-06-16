import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  createServeHealthRouteHandlers,
  registerServeHealthRoutes,
  serve,
} from "../../src/vendor-plugins/serve-config-health/index.ts?plugin-serve-config-health-standalone";

const root = join(import.meta.dir, "../..");

function jsonRequest(path: string, method: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(res: Response) {
  return await res.json() as any;
}

describe("serve-config-health plugin standalone boundary", () => {
  test("declares serve hook routes and removes old health API auto-mount", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-config-health/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.api).toBeUndefined();

    const oldHealth = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/health/plugin.json"), "utf8"));
    expect(oldHealth.api).toBeUndefined();
  });

  test("boundary drift is explicit for this core serve route plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-config-health",
      pluginDir: "src/vendor-plugins/serve-config-health",
      requireSdk: false,
      allowMawJs: ["maw-js/config"],
      allowRelative: [
        /^\.\.\/\.\.\/vendor\/mpr-plugins\/health\/index$/,
        /^\.\.\/\.\.\/core\/agent-status$/,
        /^\.\.\/\.\.\/core\/message-queue$/,
      ],
    });
  });

  test("registers config, health, and status routes through serve hook", async () => {
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();

    serve({
      http: {
        route(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
        },
      },
    });

    expect([...routes.keys()].sort()).toEqual([
      "GET /api/config",
      "GET /api/health",
      "GET /api/status",
      "GET /api/status/:oracle",
      "GET /health",
      "POST /api/config",
      "POST /api/config/reload",
      "POST /api/status",
    ]);
  });

  test("preserves GET and POST /api/config response shapes", async () => {
    const saves: any[] = [];
    const handlers = createServeHealthRouteHandlers({
      loadConfig: (() => ({ raw: true, env: { SECRET: "raw-secret" } })) as any,
      configForDisplay: (() => ({ display: true, envMasked: { SECRET: "••••" } })) as any,
      saveConfig: ((data: any) => { saves.push(data); }) as any,
    });

    expect(await readJson(await handlers.getConfig(new Request("http://localhost/api/config?raw=1")))).toEqual({ raw: true, env: { SECRET: "raw-secret" } });
    expect(await readJson(await handlers.getConfig(new Request("http://localhost/api/config")))).toEqual({ display: true, envMasked: { SECRET: "••••" } });

    const save = await handlers.postConfig(jsonRequest("/api/config", "POST", { env: { SECRET: "••••", PLAIN: "ok" } }));
    expect(save.status).toBe(200);
    expect(saves).toEqual([{ env: { SECRET: "raw-secret", PLAIN: "ok" } }]);

    const failing = createServeHealthRouteHandlers({ saveConfig: (() => { throw new Error("config save boom"); }) as any });
    const error = await failing.postConfig(jsonRequest("/api/config", "POST", { host: "local" }));
    expect(error.status).toBe(400);
    expect((await readJson(error)).error).toBe("config save boom");
  });

  test("preserves status summaries, per-oracle pending counts, validation, and config reload", async () => {
    const reports: any[] = [];
    let reloaded = 0;
    const entries = [
      { oracle: "neo", status: "busy" },
      { oracle: "trinity", status: "ready" },
      { oracle: "morpheus", status: "busy" },
    ];
    const handlers = createServeHealthRouteHandlers({
      resetConfig: (() => { reloaded += 1; }) as any,
      agentStatusStore: {
        getAll: () => entries,
        get: (oracle: string) => entries.find((entry) => entry.oracle === oracle),
        report: (...args: any[]) => { reports.push(args); },
      } as any,
      messageQueue: { pending: (oracle: string) => oracle === "neo" ? [{ id: "m1" }, { id: "m2" }] : [] } as any,
    });

    expect(await readJson(await handlers.getStatus(new Request("http://localhost/api/status")))).toEqual({
      agents: entries,
      summary: { busy: 2, ready: 1 },
      total: 3,
    });
    expect(await readJson(await handlers.getOracleStatus(new Request("http://localhost/api/status/neo"), "neo"))).toEqual({
      oracle: "neo",
      status: "busy",
      pendingMessages: 2,
    });
    expect(await readJson(await handlers.getOracleStatus(new Request("http://localhost/api/status/unknown"), "unknown"))).toEqual({ error: "not found", oracle: "unknown" });

    expect(await readJson(await handlers.postStatus(jsonRequest("/api/status", "POST", { oracle: "neo", status: "invalid" })))).toMatchObject({ error: "invalid status: invalid" });
    expect(await readJson(await handlers.postStatus(jsonRequest("/api/status", "POST", { oracle: "neo", status: "busy", sessionId: "s1" })))).toEqual({ ok: true, oracle: "neo", status: "busy" });
    expect(reports).toEqual([["neo", "busy", { sessionId: "s1", project: undefined, event: undefined }]]);

    expect(await readJson(await handlers.reloadConfig(new Request("http://localhost/api/config/reload", { method: "POST" })))).toEqual({ ok: true });
    expect(reloaded).toBe(1);
  });

  test("preserves /api/health and /health invoke-result shape and auto-mounted status semantics", async () => {
    const handlers = createServeHealthRouteHandlers({
      healthHandler: (async (ctx: any) => ({ ok: false, error: `source=${ctx.source} args=${JSON.stringify(ctx.args)}` })) as any,
    });

    const response = await handlers.health(new Request("http://localhost/api/health?verbose=1"));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: false, error: 'source=api args={"verbose":"1"}' });

    const registry = new ServeRouteRegistry();
    registerServeHealthRoutes(registry, {
      healthHandler: (async (ctx: any) => ({ ok: true, source: ctx.source, args: ctx.args })) as any,
    });
    const alias = await registry.handle(new Request("http://localhost/health?short=1"));
    expect(alias?.status).toBe(200);
    expect(await alias!.json()).toEqual({ ok: true, source: "api", args: { short: "1" } });
  });

  test("registered param route works through ServeRouteRegistry", async () => {
    const registry = new ServeRouteRegistry();
    registerServeHealthRoutes(registry, {
      agentStatusStore: {
        getAll: () => [],
        get: (oracle: string) => ({ oracle, status: "ready" }),
        report: () => {},
      } as any,
      messageQueue: { pending: () => [{ id: "queued" }] } as any,
    });

    const response = await registry.handle(new Request("http://localhost/api/status/neo"));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ oracle: "neo", status: "ready", pendingMessages: 1 });
  });

  test("serve hook fails clearly without route registration context", () => {
    expect(() => serve({})).toThrow("serve-config-health requires serve http route registration");
  });
});
