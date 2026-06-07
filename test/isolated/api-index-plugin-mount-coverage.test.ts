/** Targeted isolated coverage for src/api/index.ts API construction and plugin auto-mounting. */
import { describe, expect, mock, test } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

type RouteRecord = {
  method: string;
  path: string;
  handler?: (ctx: Record<string, unknown>) => unknown | Promise<unknown>;
};

type LoadedPluginLike = {
  manifest: {
    name: string;
    api?: { path: string; methods: string[] };
  };
};

class FakeElysia {
  routes: RouteRecord[] = [];
  usedPlugins: unknown[] = [];
  afterHandleHooks: Array<(ctx: { set: { headers: Record<string, string> } }) => void> = [];

  constructor(public options: Record<string, unknown> = {}) {}

  use(plugin: { routes?: RouteRecord[] } | unknown) {
    this.usedPlugins.push(plugin);
    if (plugin && typeof plugin === "object" && "routes" in plugin) {
      this.routes.push(...((plugin as { routes?: RouteRecord[] }).routes ?? []));
    }
    return this;
  }

  onAfterHandle(hook: (ctx: { set: { headers: Record<string, string> } }) => void) {
    this.afterHandleHooks.push(hook);
    return this;
  }

  get(path: string, handler: RouteRecord["handler"]) {
    this.routes.push({ method: "GET", path, handler });
    return this;
  }

  post(path: string, handler: RouteRecord["handler"]) {
    this.routes.push({ method: "POST", path, handler });
    return this;
  }
}

const directRoutePlugin = {
  routes: [{ method: "GET", path: "/direct-collision" }],
};
const inertPlugin = { routes: [] };

const moduleExports: Record<string, unknown> = {
  sessionsApi: directRoutePlugin,
  feedApi: inertPlugin,
  teamsApi: inertPlugin,
  configApi: inertPlugin,
  fleetApi: inertPlugin,
  asksApi: inertPlugin,
  oracleApi: inertPlugin,
  federationApi: inertPlugin,
  worktreesApi: inertPlugin,
  uiStateApi: inertPlugin,
  deprecatedApi: inertPlugin,
  costsApi: inertPlugin,
  triggersApi: inertPlugin,
  avengersApi: inertPlugin,
  transportApi: inertPlugin,
  workspaceApi: inertPlugin,
  peerExecApi: inertPlugin,
  proxyApi: inertPlugin,
  pulseApi: inertPlugin,
  pluginsRouter: inertPlugin,
  pluginListManifestApi: inertPlugin,
  pluginDownloadApi: inertPlugin,
  uploadApi: inertPlugin,
  pairApi: inertPlugin,
  consentApi: inertPlugin,
  claudeFleetApi: inertPlugin,
  peerDiscoveriesApi: inertPlugin,
  engineApi: inertPlugin,
};

const apiModules: Array<[string, string]> = [
  ["sessions", "sessionsApi"],
  ["feed", "feedApi"],
  ["teams", "teamsApi"],
  ["config", "configApi"],
  ["fleet", "fleetApi"],
  ["asks", "asksApi"],
  ["oracle", "oracleApi"],
  ["federation", "federationApi"],
  ["worktrees", "worktreesApi"],
  ["ui-state", "uiStateApi"],
  ["deprecated", "deprecatedApi"],
  ["costs", "costsApi"],
  ["triggers", "triggersApi"],
  ["avengers", "avengersApi"],
  ["transport", "transportApi"],
  ["workspace", "workspaceApi"],
  ["peer-exec", "peerExecApi"],
  ["proxy", "proxyApi"],
  ["pulse", "pulseApi"],
  ["plugins", "pluginsRouter"],
  ["plugin-list-manifest", "pluginListManifestApi"],
  ["plugin-download", "pluginDownloadApi"],
  ["upload", "uploadApi"],
  ["pair", "pairApi"],
  ["consent", "consentApi"],
  ["claude-fleet", "claudeFleetApi"],
  ["peers-discoveries", "peerDiscoveriesApi"],
  ["engine", "engineApi"],
];

for (const [moduleName, exportName] of apiModules) {
  mock.module(join(root, "src/api", moduleName), () => ({ [exportName]: moduleExports[exportName] }));
}

const mountedPlugins: LoadedPluginLike[] = [
  { manifest: { name: "no-api-surface" } },
  { manifest: { name: "collision", api: { path: "/direct-collision", methods: ["GET"] } } },
  { manifest: { name: "query-plugin", api: { path: "/query-plugin", methods: ["GET"] } } },
  { manifest: { name: "body-plugin", api: { path: "/api/body-plugin", methods: ["POST"] } } },
];

const invocations: Array<{ plugin: string; ctx: unknown }> = [];

mock.module("elysia", () => ({ Elysia: FakeElysia }));
mock.module("@elysiajs/cors", () => ({ cors: () => ({ name: "cors", routes: [] }) }));
mock.module("@elysiajs/swagger", () => ({ swagger: (options: unknown) => ({ name: "swagger", options, routes: [] }) }));
mock.module(join(root, "src/lib/elysia-auth"), () => ({
  federationAuth: { name: "federationAuth", routes: [] },
  fromSigningAuth: { name: "fromSigningAuth", routes: [] },
}));
mock.module(join(root, "src/plugin/registry"), () => ({
  discoverPackages: () => mountedPlugins,
  invokePlugin: async (plugin: LoadedPluginLike, ctx: unknown) => {
    invocations.push({ plugin: plugin.manifest.name, ctx });
    return { ok: true, plugin: plugin.manifest.name, ctx };
  },
}));

const stderrWrites: string[] = [];
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array) => {
  stderrWrites.push(String(chunk));
  return true;
}) as typeof process.stderr.write;

const { api } = await import("../../src/api/index.ts?api-index-plugin-mount-coverage");
process.stderr.write = originalStderrWrite;
const app = api as FakeElysia;

function findRoute(method: string, path: string): RouteRecord | undefined {
  return app.routes.find(route => route.method === method && route.path === path);
}

describe("src/api/index isolated plugin mounting", () => {
  test("constructs the API app with /api prefix and mounts core plugins before plugin discovery", () => {
    expect(app).toBeInstanceOf(FakeElysia);
    expect(app.options.prefix).toBe("/api");
    expect(app.usedPlugins.length).toBeGreaterThanOrEqual(apiModules.length + 4);
    expect(findRoute("GET", "/direct-collision")).toBeDefined();
  });

  test("after-handle hook allows private-network CORS preflight", () => {
    const set = { headers: {} as Record<string, string> };

    app.afterHandleHooks[0]({ set });

    expect(set.headers["Access-Control-Allow-Private-Network"]).toBe("true");
  });

  test("skips plugin auto-mount when a direct route already owns the method and path", () => {
    expect(stderrWrites.join("")).toContain("plugin 'collision' declares GET /direct-collision");
    expect(app.routes.filter(route => route.method === "GET" && route.path === "/direct-collision")).toHaveLength(1);
  });

  test("auto-mounts GET plugin API paths and forwards query args", async () => {
    const route = findRoute("GET", "/query-plugin");

    expect(route).toBeDefined();
    const result = await route!.handler!({ query: { search: "oracle", limit: "2" } });

    expect(result).toEqual({
      ok: true,
      plugin: "query-plugin",
      ctx: { source: "api", args: { search: "oracle", limit: "2" } },
    });
    expect(invocations).toContainEqual({
      plugin: "query-plugin",
      ctx: { source: "api", args: { search: "oracle", limit: "2" } },
    });
  });

  test("auto-mounts POST plugin API paths, strips /api prefix, and forwards body args", async () => {
    const route = findRoute("POST", "/body-plugin");

    expect(route).toBeDefined();
    const result = await route!.handler!({ body: { enabled: true } });

    expect(result).toEqual({
      ok: true,
      plugin: "body-plugin",
      ctx: { source: "api", args: { enabled: true } },
    });
    expect(findRoute("POST", "/api/body-plugin")).toBeUndefined();
  });
});
