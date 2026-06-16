import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

process.env.MAW_CLI = "1";
process.env.MAW_UI_DIR = join(tmpdir(), "maw-core-shared-server-missing-ui");

let config: Record<string, any> = {};
let sessions: Array<{ name: string }> = [];
let serveCalls: any[] = [];
let killed: string[] = [];
let engineCalls: string[] = [];
let ptyMessages: unknown[] = [];
let ptyCloses: unknown[] = [];
let tmuxStreamEvents: string[] = [];
let apiPaths: string[] = [];
let proxiedPaths: string[] = [];
let lifecyclePayloads: unknown[] = [];
let transportProfiles: unknown[] = [];
let transportRouters: unknown[] = [];
let engineRouters: unknown[] = [];
let healthPolls = 0;
let tmp = "";

class FakeEngine {
  setTransportRouter(router: unknown) {
    engineCalls.push("router");
    engineRouters.push(router);
  }
  handleOpen() { engineCalls.push("open"); }
  handleMessage() { engineCalls.push("message"); }
  handleClose() { engineCalls.push("close"); }
}

mock.module(import.meta.resolve("../../src/engine"), () => ({ MawEngine: FakeEngine }));
mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/api"), () => ({
  api: { handle: (req: Request) => {
    const url = new URL(req.url);
    apiPaths.push(url.pathname);
    if (url.pathname === "/api/triggers/fire") return new Response("not found", { status: 404 });
    if (url.pathname === "/api/worktrees/cleanup") return new Response("legacy missing", { status: 404 });
    if (url.pathname === "/api/protected-auth-fail") return new Response("auth failed", { status: 401 });
    return new Response("api");
  } },
}));
mock.module(import.meta.resolve("../../src/api/feed"), () => ({
  feedBuffer: [],
  feedListeners: new Set(),
  pushFeedEvent: () => {},
  pushFeedEventWithDeps: () => {},
}));
mock.module(import.meta.resolve("../../src/views/index"), () => ({
  mountViews: (views: Hono) => { views.get("/throws", () => { throw new Error("view failed"); }); },
}));
mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({ setupTriggerListener: () => {} }));
function createFakeTransportRouter(transports?: string[]) {
  const router = { transports, connectAll: () => Promise.resolve() };
  transportProfiles.push(transports);
  transportRouters.push(router);
  return router;
}

mock.module(import.meta.resolve("../../src/transports"), () => ({
  createScopedTransportRouter: createFakeTransportRouter,
  createTransportRouter: createFakeTransportRouter,
  getTransportRouter: () => null,
  resetTransportRouter: () => {},
}));
mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({
  hostExec: async () => "",
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  HostExecError: class HostExecError extends Error {},
  listSessions: async () => sessions,
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmuxCmd: () => "tmux-test",
  resolveSocket: () => [],
  tmux: { run: async () => "", listSessions: async () => [] },
  withPaneLock: async (fn: () => unknown) => await fn(),
  splitWindowLocked: async () => undefined,
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
  Tmux: class { async killSession(name: string) { killed.push(name); } },
}));
mock.module(import.meta.resolve("../../src/core/transport/pty"), () => ({
  handlePtyMessage: (...args: unknown[]) => { ptyMessages.push(args); },
  handlePtyClose: (...args: unknown[]) => { ptyCloses.push(args); },
  sweepOrphanPtySessions: async () => ({ killed: [], checked: 0 }),
}));
mock.module(import.meta.resolve("../../src/api/tmux-stream"), () => ({
  handleTmuxStreamOpen: () => { tmuxStreamEvents.push("open"); },
  handleTmuxStreamMessage: () => { tmuxStreamEvents.push("message"); },
  handleTmuxStreamClose: () => { tmuxStreamEvents.push("close"); },
}));
mock.module(import.meta.resolve("../../src/lib/elysia-auth"), () => ({
  setBunServer: () => {},
  isProtected: (path: string, method: string) => method === "POST" && (
    path === "/triggers/fire" || path === "/worktrees/cleanup" || path === "/protected-auth-fail"
  ),
}));
mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runServeLifecycleHooks: async (payload: any) => {
    lifecyclePayloads.push(payload);
    payload.http?.route("GET", "/api/triggers", () => new Response("plugin triggers"));
    payload.http?.route("POST", "/api/triggers/fire", () => new Response("plugin trigger fire"));
    payload.http?.route("POST", "/api/worktrees/cleanup", () => new Response("plugin cleanup"));
    payload.http?.route("POST", "/api/protected-auth-fail", () => new Response("should not bypass auth"));
    if (!payload.ws?.snapshot?.().includes("/ws/tmux")) {
      payload.ws?.route("/ws/tmux", () => ({ target: null, previewTargets: new Set(), mode: "tmux-stream" }), {
        open: () => { tmuxStreamEvents.push("open"); },
        message: () => { tmuxStreamEvents.push("message"); },
        close: () => { tmuxStreamEvents.push("close"); },
      });
    }
  },
}));
mock.module(import.meta.resolve("../../src/core/engine-plugin-registry"), () => ({
  dispatchEnginePluginEvent: async () => {},
  findEnginePluginRegistration: (pathname: string) => pathname === "/api/engine" ? { name: "engine" } : null,
  hasEnginePluginEventSink: () => false,
  proxyEnginePluginRequest: (req: Request) => { proxiedPaths.push(new URL(req.url).pathname); return new Response("proxied"); },
  startEnginePluginHealthPolling: () => { healthPolls += 1; },
}));
mock.module(import.meta.resolve("../../src/plugins/index"), () => ({
  PluginSystem: class { emit() {}; stats() { return { loaded: 0 }; } },
  loadPlugins: async () => {},
  reloadUserPlugins: async () => {},
  watchUserPlugins: () => {},
  registerManifestHooks: async () => {},
}));
mock.module(import.meta.resolve("../../src/lib/peers/store"), () => ({ loadPeers: () => ({ peers: {} }) }));
mock.module(import.meta.resolve("../../src/lib/peers/duplicate-detect"), () => ({ warnDuplicatesAtBoot: () => {} }));

const { createViews, startServer, createServeLogger, normalizeServeVerbosity, formatBatchedUiStateAccessLog } = await import("../../src/core/server.ts?coverage-core-shared-server");

const original = {
  serve: Bun.serve,
  cli: process.env.MAW_CLI,
  ui: process.env.MAW_UI_DIR,
  cwd: process.cwd(),
  log: console.log,
  stderrWrite: process.stderr.write,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-core-shared-server-"));
  config = { bind: "127.0.0.1", federationToken: "1234567890123456", node: "m5", oracle: "sender" };
  sessions = [{ name: "maw-pty-stale" }, { name: "sender-view" }, { name: "live" }];
  serveCalls = [];
  killed = [];
  engineCalls = [];
  ptyMessages = [];
  ptyCloses = [];
  tmuxStreamEvents = [];
  apiPaths = [];
  proxiedPaths = [];
  lifecyclePayloads = [];
  transportProfiles = [];
  transportRouters = [];
  engineRouters = [];
  healthPolls = 0;
  Bun.serve = ((opts: any) => {
    serveCalls.push(opts);
    return { stop: () => {} } as never;
  }) as typeof Bun.serve;
  console.log = () => {};
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  Bun.serve = original.serve;
  console.log = original.log;
  process.stderr.write = original.stderrWrite;
  if (original.cli === undefined) delete process.env.MAW_CLI; else process.env.MAW_CLI = original.cli;
  if (original.ui === undefined) delete process.env.MAW_UI_DIR; else process.env.MAW_UI_DIR = original.ui;
  process.chdir(original.cwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("coverage core shared server", () => {
  test("serve verbosity logger gates non-error output", () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    const oldLog = console.log;
    const oldWarn = console.warn;
    const oldError = console.error;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
    try {
      expect(normalizeServeVerbosity("0")).toBe(0);
      expect(normalizeServeVerbosity("quiet")).toBe(0);
      expect(normalizeServeVerbosity("2")).toBe(2);
      expect(normalizeServeVerbosity("verbose")).toBe(2);
      expect(normalizeServeVerbosity("3")).toBe(3);
      expect(normalizeServeVerbosity("access")).toBe(3);
      expect(normalizeServeVerbosity("4")).toBe(4);
      expect(normalizeServeVerbosity("frames")).toBe(4);
      expect(normalizeServeVerbosity(99)).toBe(4);
      expect(normalizeServeVerbosity(undefined)).toBe(1);

      const quiet = createServeLogger(0);
      quiet.info("quiet-info");
      quiet.warn("quiet-warn");
      quiet.debug("quiet-debug");
      quiet.access("quiet-access");
      quiet.frame("quiet-frame");
      quiet.error("quiet-error");
      expect(logs).toEqual([]);
      expect(warns).toEqual([]);
      expect(errors).toEqual(["quiet-error"]);

      const normal = createServeLogger(1);
      normal.info("normal-info");
      normal.warn("normal-warn");
      normal.debug("normal-debug");
      expect(logs).toEqual(["normal-info"]);
      expect(warns).toEqual(["normal-warn"]);

      const verbose = createServeLogger(2);
      verbose.debug("verbose-debug");
      expect(logs).toEqual(["normal-info", "verbose-debug"]);

      const access = createServeLogger(3);
      access.access("access-log");
      access.frame("hidden-frame");
      expect(logs).toEqual(["normal-info", "verbose-debug", "access-log"]);

      const frames = createServeLogger(4);
      frames.frame("frame-log");
      expect(logs).toEqual(["normal-info", "verbose-debug", "access-log", "frame-log"]);
    } finally {
      console.log = oldLog;
      console.warn = oldWarn;
      console.error = oldError;
    }
  });

  test("batches noisy ui-state access logs", () => {
    const state = { count: 0, windowStartedAt: 1_000 };

    expect(formatBatchedUiStateAccessLog(state, { method: "GET", status: 200, now: 1_100 })).toBeNull();
    expect(formatBatchedUiStateAccessLog(state, { method: "GET", status: 200, now: 10_999 })).toBeNull();
    expect(formatBatchedUiStateAccessLog(state, { method: "GET", status: 200, now: 11_000 })).toBe(
      "[serve:http] GET /api/ui-state -> 200 (3 requests/10s)",
    );
    expect(state).toEqual({ count: 0, windowStartedAt: 11_000 });
  });

  test("createViews covers topology success, missing door fallback, and error JSON", async () => {
    mkdirSync(join(tmp, "ψ", "outbox"), { recursive: true });
    writeFileSync(join(tmp, "ψ", "outbox", "fleet-topology.html"), "<h1>topology</h1>");
    process.chdir(tmp);

    const views = createViews(join(tmp, "missing-ui"), join(tmp, "missing-door.html"));

    expect(await (await views.request("http://local/topology")).text()).toContain("topology");
    rmSync(join(tmp, "ψ"), { recursive: true, force: true });
    expect((await views.request("http://local/topology")).status).toBe(404);
    expect(await (await views.request("http://local/")).text()).toContain("maw-ui not installed");
    const failed = await views.request("http://local/throws");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "view failed" });
  });

  test("startServer exposes fetch and websocket handlers without real network side effects", async () => {
    const serveLogs: string[] = [];
    console.log = (...a: unknown[]) => { serveLogs.push(a.map(String).join(" ")); };
    await startServer(4910, { verbosity: 4 });

    // Startup stale-session cleanup moved to the serve-session-reaper lifecycle
    // plugin; server.ts now proves the plugin context is wired instead of
    // directly killing tmux sessions here.
    expect(killed).toEqual([]);
    expect(engineCalls).toContain("router");
    expect(lifecyclePayloads).toHaveLength(1);
    expect(transportProfiles).toEqual([undefined]);
    expect(lifecyclePayloads[0]).toMatchObject({
      port: 4910,
      httpUrl: "http://localhost:4910",
      wsUrl: "ws://localhost:4910/ws",
      hostname: "127.0.0.1",
      log: expect.any(Object),
      plugins: expect.any(Object),
      reloadPlugins: expect.any(Function),
      profile: { views: true, apiRouters: undefined },
    });
    expect((lifecyclePayloads[0] as any).http).toEqual(expect.objectContaining({ route: expect.any(Function) }));
    // Engine plugin health polling moved to serve-engine-health-polling; this
    // isolated server.ts test mocks lifecycle hooks and therefore does not run
    // plugin-owned startup work directly.
    expect(healthPolls).toBe(0);

    const ws = serveCalls[0].websocket;
    const normal = { data: {} };
    const pty = { data: { mode: "pty" } };
    const tmuxStream = { data: { mode: "tmux-stream" } };
    ws.open(normal);
    ws.open(pty);
    ws.open(tmuxStream);
    ws.message(normal, "hello");
    ws.message(pty, "resize");
    ws.message(tmuxStream, "refresh");
    ws.close(normal);
    ws.close(pty);
    ws.close(tmuxStream);
    expect(engineCalls).toEqual(["router", "open", "message", "close"]);
    expect(ptyMessages).toHaveLength(1);
    expect(ptyCloses).toHaveLength(1);
    expect(tmuxStreamEvents).toEqual(["open", "message", "close"]);
    expect(serveLogs.some((line) => line.includes("[serve:ws] open /ws"))).toBe(true);
    expect(serveLogs.some((line) => line.includes("[serve:ws] message /ws:pty 6B"))).toBe(true);

    const fetch = serveCalls[0].fetch;
    const options = await fetch(new Request("http://local/anything", { method: "OPTIONS", headers: { origin: "http://origin.test" } }), upgradeServer(true));
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("http://origin.test");
    expect(await (await fetch(new Request("http://local/api/engine"), upgradeServer(true))).text()).toBe("proxied");
    expect(proxiedPaths).toEqual(["/api/engine"]);
    expect(await (await fetch(new Request("http://local/api/triggers"), upgradeServer(true))).text()).toBe("plugin triggers");
    expect(await (await fetch(new Request("http://local/api/triggers/fire", { method: "POST" }), upgradeServer(true))).text()).toBe("plugin trigger fire");
    expect(await (await fetch(new Request("http://local/api/worktrees/cleanup", { method: "POST", body: JSON.stringify({ path: "/tmp/wt" }) }), upgradeServer(true))).text()).toBe("plugin cleanup");
    const authFailed = await fetch(new Request("http://local/api/protected-auth-fail", { method: "POST" }), upgradeServer(true));
    expect(authFailed.status).toBe(401);
    expect(await authFailed.text()).toBe("auth failed");
    expect(await (await fetch(new Request("http://local/api/ordinary"), upgradeServer(true))).text()).toBe("api");
    expect(apiPaths).toEqual(["/api/triggers/fire", "/api/worktrees/cleanup", "/api/protected-auth-fail", "/api/ordinary"]);

    const ptyUpgrade = upgradeServer(true);
    expect(await fetch(new Request("http://local/ws/pty"), ptyUpgrade)).toBeUndefined();
    expect(ptyUpgrade.upgrades[0].data.mode).toBe("pty");
    const tmuxUpgrade = upgradeServer(true);
    expect(await fetch(new Request("http://local/ws/tmux"), tmuxUpgrade)).toBeUndefined();
    expect(tmuxUpgrade.upgrades[0].data.mode).toBe("tmux-stream");
    const failedUpgrade = await fetch(new Request("http://local/ws"), upgradeServer(false));
    expect(failedUpgrade.status).toBe(400);
    expect(serveLogs.some((line) => line.includes("[serve:http] OPTIONS /anything -> 204"))).toBe(true);
    expect(serveLogs.some((line) => line.includes("[serve:http] GET /ws/pty -> 101"))).toBe(true);
  });

  test("startServer accepts a lean ServeProfile while preserving startup guard slots", async () => {
    await startServer(4911, { transports: ["tmux"], views: false, intervals: false, apiRouters: ["identity"] });

    expect(transportProfiles).toEqual([["tmux"]]);
    expect(engineCalls).toContain("router");
    expect(lifecyclePayloads).toHaveLength(1);
    expect(lifecyclePayloads[0]).toMatchObject({
      port: 4911,
      profile: { views: false, apiRouters: ["identity"] },
    });
    expect(serveCalls).toHaveLength(1);
  });

  test("startServer scopes transport routers to sequential ServeProfiles without state bleed", async () => {
    await startServer(4912, { transports: ["tmux"], views: false, intervals: false });
    await startServer(4913, { transports: ["http"], views: false, intervals: false });

    expect(transportProfiles).toEqual([["tmux"], ["http"]]);
    expect(transportRouters).toHaveLength(2);
    expect(transportRouters[0]).not.toBe(transportRouters[1]);
    expect(engineRouters).toEqual(transportRouters);
    expect(engineRouters[0]).toMatchObject({ transports: ["tmux"] });
    expect(engineRouters[1]).toMatchObject({ transports: ["http"] });
  });

});

function upgradeServer(ok: boolean) {
  return {
    upgrades: [] as any[],
    upgrade(req: Request, opts: unknown) {
      this.upgrades.push({ req, ...(opts as object) });
      return ok;
    },
  };
}
