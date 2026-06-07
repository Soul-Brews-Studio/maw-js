import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";
import { isUserError } from "../../src/core/util/user-error";

process.env.MAW_CLI = "1";
process.env.MAW_UI_DIR = join(tmpdir(), "maw-ui-missing-core-server-test");

let config: Record<string, any> = {};
let sessions: Array<{ name: string }> = [];
let serveCalls: any[] = [];
let killed: string[] = [];
let engineInstances: FakeEngine[] = [];
let ptyMessages: unknown[][] = [];
let ptyCloses: unknown[] = [];
let triggerListeners: unknown[] = [];
let transportConnects = 0;
let transportShouldThrow = false;
let transportConnectShouldReject = false;
let setServerCalls: unknown[] = [];
let lifecycleCalls: unknown[] = [];
let lifecycleShouldThrow = false;
let healthPolls = 0;
let enginePluginDispatches: unknown[] = [];
let enginePluginDispatchShouldReject = false;
let enginePluginProxyCalls: unknown[] = [];
let apiCalls: string[] = [];
let pluginEmits: unknown[] = [];
let pluginLoads: unknown[] = [];
let pluginReloads: unknown[] = [];
let pluginWatchDirs: string[] = [];
let pluginWatchCallbacks: Array<(changedFile: string) => unknown> = [];
let manifestHookCalls = 0;
let duplicateWarnings: unknown[] = [];
let peersShouldThrow: unknown = false;
let logs: string[] = [];
let warns: string[] = [];
let errors: string[] = [];
let stopCalls: unknown[] = [];
let tmp = "";

const feedListeners = new Set<(event: unknown) => unknown>();
const feedBuffer: unknown[] = [];

class FakeEngine {
  calls: Array<{ method: string; args: unknown[] }> = [];
  router: unknown;

  constructor(public opts: unknown) {
    engineInstances.push(this);
  }

  setTransportRouter(router: unknown) { this.router = router; this.calls.push({ method: "setTransportRouter", args: [router] }); }
  handleOpen(ws: unknown) { this.calls.push({ method: "open", args: [ws] }); }
  handleMessage(ws: unknown, msg: unknown) { this.calls.push({ method: "message", args: [ws, msg] }); }
  handleClose(ws: unknown) { this.calls.push({ method: "close", args: [ws] }); }
}

class FakePluginSystem {
  constructor(public opts: { shouldSkipHandler?: (eventName: string, pluginName?: string) => boolean }) {
    opts.shouldSkipHandler?.("feed", "sink");
  }
  emit(event: unknown) { pluginEmits.push(event); }
  stats() { return { loaded: 2, ok: true }; }
}

mock.module(import.meta.resolve("../../src/engine"), () => ({ MawEngine: FakeEngine }));
mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/api"), () => ({
  api: { handle: (req: Request) => { apiCalls.push(new URL(req.url).pathname); return new Response("api"); } },
}));
mock.module(import.meta.resolve("../../src/api/feed"), () => ({ feedBuffer, feedListeners }));
mock.module(import.meta.resolve("../../src/views/index"), () => ({
  mountViews: (views: Hono) => { views.get("/mounted", c => c.text("mounted view")); },
}));
mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({
  setupTriggerListener: (listeners: unknown) => { triggerListeners.push(listeners); },
}));
mock.module(import.meta.resolve("../../src/transports"), () => ({
  createTransportRouter: () => {
    if (transportShouldThrow) throw new Error("router boom");
    return {
      connectAll: () => {
        transportConnects += 1;
        return transportConnectShouldReject ? Promise.reject(new Error("connect boom")) : Promise.resolve();
      },
    };
  },
}));
mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => mockSshModule({
  listSessions: async () => sessions,
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  Tmux: class { async killSession(name: string) { killed.push(name); } },
}));
mock.module(import.meta.resolve("../../src/core/transport/pty"), () => ({
  handlePtyMessage: (...args: unknown[]) => { ptyMessages.push(args); },
  handlePtyClose: (ws: unknown) => { ptyCloses.push(ws); },
}));
mock.module(import.meta.resolve("../../src/lib/elysia-auth"), () => ({ setBunServer: (server: unknown) => setServerCalls.push(server) }));
mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runServeLifecycleHooks: async (payload: unknown) => {
    lifecycleCalls.push(payload);
    if (lifecycleShouldThrow) throw new Error("lifecycle boom");
  },
}));
mock.module(import.meta.resolve("../../src/core/engine-plugin-registry"), () => ({
  dispatchEnginePluginEvent: async (event: unknown) => {
    enginePluginDispatches.push(event);
    if (enginePluginDispatchShouldReject) throw new Error("dispatch boom");
  },
  findEnginePluginRegistration: (pathname: string) => pathname === "/api/engine/test" ? { name: "engine-test" } : null,
  hasEnginePluginEventSink: (pluginName: string | undefined, eventName: string) => pluginName === "sink" && eventName === "feed",
  proxyEnginePluginRequest: (req: Request, registration: unknown) => {
    enginePluginProxyCalls.push([new URL(req.url).pathname, registration]);
    return new Response("proxied");
  },
  startEnginePluginHealthPolling: () => { healthPolls += 1; },
}));
mock.module(import.meta.resolve("../../src/plugins/index"), () => ({
  PluginSystem: FakePluginSystem,
  loadPlugins: async (...args: unknown[]) => { pluginLoads.push(args); },
  reloadUserPlugins: async (...args: unknown[]) => { pluginReloads.push(args); },
  watchUserPlugins: (dir: string, cb: (changedFile: string) => unknown) => { pluginWatchDirs.push(dir); pluginWatchCallbacks.push(cb); },
  registerManifestHooks: async () => { manifestHookCalls += 1; },
}));
mock.module(import.meta.resolve("../../src/views/plugins"), () => ({
  pluginsView: () => new Hono().get("/", c => c.text("plugins view")),
}));
mock.module(import.meta.resolve("../../src/lib/peers/store"), () => ({
  loadPeers: () => {
    if (peersShouldThrow) throw (peersShouldThrow instanceof Error ? peersShouldThrow : new Error("peers boom"));
    return { peers: { remote: { node: "remote" } } };
  },
}));
mock.module(import.meta.resolve("../../src/lib/peers/duplicate-detect"), () => ({
  warnDuplicatesAtBoot: (payload: unknown) => { duplicateWarnings.push(payload); },
}));

const { startServer, views, createViews, VERSION } = await import("../../src/core/server.ts?core-server-coverage");

const original = {
  serve: Bun.serve,
  log: console.log,
  warn: console.warn,
  error: console.error,
  cli: process.env.MAW_CLI,
  ui: process.env.MAW_UI_DIR,
  dataDir: process.env.MAW_DATA_DIR,
  pluginsDir: process.env.MAW_PLUGINS_DIR,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-core-server-"));
  process.env.MAW_DATA_DIR = join(tmp, "data");
  delete process.env.MAW_PLUGINS_DIR;
  config = { node: "local-node", oracle: "mawjs", peers: [{ host: "peer" }] };
  sessions = [{ name: "maw-pty-old" }, { name: "keeper" }, { name: "agent-view" }];
  serveCalls = [];
  killed = [];
  engineInstances = [];
  ptyMessages = [];
  ptyCloses = [];
  triggerListeners = [];
  transportConnects = 0;
  transportShouldThrow = false;
  transportConnectShouldReject = false;
  setServerCalls = [];
  lifecycleCalls = [];
  lifecycleShouldThrow = false;
  healthPolls = 0;
  enginePluginDispatches = [];
  enginePluginDispatchShouldReject = false;
  enginePluginProxyCalls = [];
  apiCalls = [];
  pluginEmits = [];
  pluginLoads = [];
  pluginReloads = [];
  pluginWatchDirs = [];
  pluginWatchCallbacks = [];
  manifestHookCalls = 0;
  duplicateWarnings = [];
  peersShouldThrow = false;
  feedListeners.clear();
  logs = [];
  warns = [];
  errors = [];
  stopCalls = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  Bun.serve = ((opts: any) => {
    serveCalls.push(opts);
    return { id: serveCalls.length, stop: (force?: boolean) => { stopCalls.push(force); } } as never;
  }) as typeof Bun.serve;
});

afterEach(() => {
  Bun.serve = original.serve;
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
  if (original.cli === undefined) delete process.env.MAW_CLI; else process.env.MAW_CLI = original.cli;
  if (original.ui === undefined) delete process.env.MAW_UI_DIR; else process.env.MAW_UI_DIR = original.ui;
  if (original.dataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = original.dataDir;
  if (original.pluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR; else process.env.MAW_PLUGINS_DIR = original.pluginsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("core server startup and routing", () => {
  test("startServer wires startup cleanup, plugins, ws routing, CORS, APIs, lifecycle, and TLS", async () => {
    const cert = join(tmp, "cert.pem");
    const key = join(tmp, "key.pem");
    writeFileSync(cert, "cert-bytes");
    writeFileSync(key, "key-bytes");
    config.tls = { cert, key };

    const server = await startServer(4567) as any;

    expect(server.id).toBe(1);
    expect(killed).toEqual(["maw-pty-old", "agent-view"]);
    expect(transportConnects).toBe(1);
    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0].router).toBeDefined();
    expect(triggerListeners).toEqual([feedListeners]);
    expect(pluginLoads).toHaveLength(2);
    expect(manifestHookCalls).toBe(1);
    expect(pluginWatchDirs[0]).toBe(join(tmp, "data", "plugins"));
    expect(VERSION).toStartWith("v");
    await pluginWatchCallbacks[0]("fresh.ts");
    expect(logs.join("\n")).toContain("fresh.ts changed");
    expect(pluginReloads).toHaveLength(1);
    expect(duplicateWarnings).toHaveLength(1);
    expect(setServerCalls).toEqual([server]);
    expect(healthPolls).toBe(1);
    expect(lifecycleCalls).toEqual([{ port: 4567, httpUrl: "http://localhost:4567", wsUrl: "ws://localhost:4567/ws", hostname: "0.0.0.0" }]);
    expect(serveCalls).toHaveLength(2);
    expect(serveCalls[0].hostname).toBe("0.0.0.0");
    expect(serveCalls[1]).toMatchObject({ port: 4568, tls: { cert: Buffer.from("cert-bytes"), key: Buffer.from("key-bytes") } });
    expect(warns.join("\n")).toContain("WITHOUT authentication");

    for (const listener of feedListeners) await listener({ type: "feed", payload: 1 });
    expect(enginePluginDispatches).toEqual([{ type: "feed", payload: 1 }]);
    expect(pluginEmits).toEqual([{ type: "feed", payload: 1 }]);
    enginePluginDispatchShouldReject = true;
    for (const listener of feedListeners) await listener({ type: "feed", payload: 2 });
    await Promise.resolve();
    expect(warns.join("\n")).toContain("event dispatch failed: dispatch boom");

    const wsHandler = serveCalls[0].websocket;
    const normalWs = { data: {}, tag: "normal" };
    const ptyWs = { data: { mode: "pty" }, tag: "pty" };
    wsHandler.open(normalWs);
    wsHandler.open(ptyWs);
    wsHandler.message(normalWs, "hello");
    wsHandler.message(ptyWs, "resize");
    wsHandler.close(normalWs);
    wsHandler.close(ptyWs);
    expect(engineInstances[0].calls.map(c => c.method)).toEqual(["setTransportRouter", "open", "message", "close"]);
    expect(ptyMessages).toEqual([[ptyWs, "resize"]]);
    expect(ptyCloses).toEqual([ptyWs]);

    const fetch = serveCalls[0].fetch;
    const originReq = new Request("http://local/mounted", { headers: { origin: "http://example.test" } });
    const mounted = await fetch(originReq, upgradeServer(true));
    expect(await mounted.text()).toBe("mounted view");
    expect(mounted.headers.get("Access-Control-Allow-Origin")).toBe("http://example.test");

    const options = await fetch(new Request("http://local/anything", { method: "OPTIONS", headers: { origin: "http://preflight.test" } }), upgradeServer(true));
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Private-Network")).toBe("true");

    expect(await (await fetch(new Request("http://local/api/engine/test"), upgradeServer(true))).text()).toBe("proxied");
    expect(enginePluginProxyCalls).toHaveLength(1);
    expect(await (await fetch(new Request("http://local/api/ordinary"), upgradeServer(true))).text()).toBe("api");
    expect(apiCalls).toEqual(["/api/ordinary"]);

    const ptyUpgrade = upgradeServer(true);
    expect(await fetch(new Request("http://local/ws/pty"), ptyUpgrade)).toBeUndefined();
    expect(ptyUpgrade.upgrades[0].data.mode).toBe("pty");
    const wsUpgrade = upgradeServer(true);
    expect(await fetch(new Request("http://local/ws"), wsUpgrade)).toBeUndefined();
    expect(wsUpgrade.upgrades[0].data.previewTargets).toBeInstanceOf(Set);
    const failedPtyUpgrade = await fetch(new Request("http://local/ws/pty"), upgradeServer(false));
    expect(failedPtyUpgrade.status).toBe(400);
    expect(await failedPtyUpgrade.text()).toBe("WebSocket upgrade failed");
    const failedUpgrade = await fetch(new Request("http://local/ws"), upgradeServer(false));
    expect(failedUpgrade.status).toBe(400);
    expect(await failedUpgrade.text()).toBe("WebSocket upgrade failed");

    const pluginsApi = await views.request("http://local/api/plugins");
    expect(await pluginsApi.json()).toEqual({ loaded: 2, ok: true });
    const reloadApi = await views.request("http://local/api/plugins/reload", { method: "POST" });
    expect(await reloadApi.json()).toEqual({ ok: true, loaded: 2 });
    expect(pluginReloads).toHaveLength(2);

    mkdirSync(join(tmp, "ψ", "outbox"), { recursive: true });
    writeFileSync(join(tmp, "ψ", "outbox", "fleet-topology.html"), "<h1>fleet</h1>");
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      const customViews = createViews(tmp);
      expect(await (await customViews.request("http://local/topology")).text()).toContain("fleet");
      rmSync(join(tmp, "ψ"), { recursive: true, force: true });
      const missingTopology = await customViews.request("http://local/topology");
      expect(missingTopology.status).toBe(404);
      const staticRes = await customViews.request("http://local/missing-static-file");
      expect(staticRes.status).toBe(404);

      const fallbackViews = createViews(join(tmp, "missing-ui"), join(tmp, "missing-door.html"));
      expect(await (await fallbackViews.request("http://local/")).text()).toContain("maw-ui not installed");
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("startup handles non-fatal transport init errors and stops server when lifecycle hooks fail", async () => {
    config = { bind: "127.9.9.9", federationToken: "1234567890123456" };
    sessions = [];
    transportShouldThrow = true;
    lifecycleShouldThrow = true;
    peersShouldThrow = new Error("peer bad");

    await expect(startServer(5678)).rejects.toThrow("lifecycle boom");

    expect(errors.join("\n")).toContain("router init failed");
    expect(warns.join("\n")).toContain("peer dedup scan skipped: peer bad");
    expect(serveCalls).toHaveLength(1);
    expect(serveCalls[0].hostname).toBe("127.9.9.9");
    expect(stopCalls).toEqual([true]);
  });

  test("port conflicts print serve instructions instead of leaking a Bun listen stack", async () => {
    config = { bind: "127.0.0.1", federationToken: "1234567890123456" };
    sessions = [];
    Bun.serve = ((opts: any) => {
      serveCalls.push(opts);
      const err = new Error("Failed to start server. Is port 4569 in use?");
      Object.assign(err, { code: "EADDRINUSE", syscall: "listen" });
      throw err;
    }) as typeof Bun.serve;

    let caught: unknown;
    try {
      await startServer(4569);
    } catch (err) {
      caught = err;
    }

    expect(isUserError(caught)).toBe(true);
    expect((caught as Error).message).toContain("port 4569 is already in use");
    const text = errors.join("\n");
    expect(text).toContain("maw serve cannot start: 127.0.0.1:4569 is already in use");
    expect(text).toContain("maw serve status");
    expect(text).toContain("maw serve stop");
    expect(text).toContain("lsof -nP -iTCP:4569 -sTCP:LISTEN");
    expect(text).toContain("maw serve 4570");
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
