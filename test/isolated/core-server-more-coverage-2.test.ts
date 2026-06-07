import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const uiDir = mkdtempSync(join(tmpdir(), "maw-ui-present-core-server-"));
process.env.MAW_UI_DIR = uiDir;
delete process.env.MAW_CLI;

let config: Record<string, any> = {};
let serveCalls: any[] = [];
let stopShouldThrow = false;
let lifecycleShouldThrow = false;
let sessionsShouldThrow = false;
let connectShouldReject = false;
let pluginLoadShouldThrow = false;
let peersShouldThrow: unknown = false;
let watchCallbacks: Array<(changedFile: string) => unknown> = [];
let pluginReloads: unknown[][] = [];
let skipDecisions: boolean[] = [];
let logs: string[] = [];
let warns: string[] = [];
let errors: string[] = [];
let tmp = "";
let previousCwd = process.cwd();

const feedListeners = new Set<(event: unknown) => unknown>();
const feedBuffer: unknown[] = [];

class FakeEngine {
  setTransportRouter(_router: unknown) {}
  handleOpen(_ws: unknown) {}
  handleMessage(_ws: unknown, _msg: unknown) {}
  handleClose(_ws: unknown) {}
}

class FakePluginSystem {
  constructor(public opts: { shouldSkipHandler: (eventName: string, pluginName?: string) => boolean }) {
    skipDecisions.push(opts.shouldSkipHandler("feed", "sink"));
    skipDecisions.push(opts.shouldSkipHandler("feed", "plain"));
  }
  emit(_event: unknown) {}
  stats() { return { loaded: 1 }; }
}

mock.module(import.meta.resolve("../../src/engine"), () => ({ MawEngine: FakeEngine }));
mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/api"), () => ({
  api: { handle: () => new Response("api") },
}));
mock.module(import.meta.resolve("../../src/api/feed"), () => ({ feedBuffer, feedListeners }));
mock.module(import.meta.resolve("../../src/views/index"), () => ({
  mountViews: (views: Hono) => { views.get("/boom", () => { throw new Error("view exploded"); }); },
}));
mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({
  setupTriggerListener: () => {},
}));
mock.module(import.meta.resolve("../../src/transports"), () => ({
  createTransportRouter: () => ({
    connectAll: () => connectShouldReject ? Promise.reject(new Error("connect rejected")) : Promise.resolve(),
  }),
}));
mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({
  listSessions: async () => {
    if (sessionsShouldThrow) throw new Error("tmux unavailable");
    return [];
  },
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  Tmux: class { async killSession(_name: string) {} },
}));
mock.module(import.meta.resolve("../../src/core/transport/pty"), () => ({
  handlePtyMessage: () => {},
  handlePtyClose: () => {},
}));
mock.module(import.meta.resolve("../../src/lib/elysia-auth"), () => ({ setBunServer: () => {} }));
mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runServeLifecycleHooks: async () => {
    if (lifecycleShouldThrow) throw new Error("lifecycle failed");
  },
}));
mock.module(import.meta.resolve("../../src/core/engine-plugin-registry"), () => ({
  dispatchEnginePluginEvent: async () => { throw new Error("dispatch rejected"); },
  findEnginePluginRegistration: () => null,
  hasEnginePluginEventSink: (pluginName: string | undefined, eventName: string) => pluginName === "sink" && eventName === "feed",
  proxyEnginePluginRequest: () => new Response("proxied"),
  startEnginePluginHealthPolling: () => {},
}));
mock.module(import.meta.resolve("../../src/plugins/index"), () => ({
  PluginSystem: FakePluginSystem,
  loadPlugins: async () => {
    if (pluginLoadShouldThrow) throw new Error("plugin load failed");
  },
  reloadUserPlugins: async (...args: unknown[]) => { pluginReloads.push(args); },
  watchUserPlugins: (_dir: string, cb: (changedFile: string) => unknown) => { watchCallbacks.push(cb); },
  registerManifestHooks: async () => {},
}));
mock.module(import.meta.resolve("../../src/views/plugins"), () => ({
  pluginsView: () => new Hono().get("/", c => c.text("plugins")),
}));
mock.module(import.meta.resolve("../../src/lib/peers/store"), () => ({
  loadPeers: () => {
    if (peersShouldThrow) throw (peersShouldThrow instanceof Error ? peersShouldThrow : new Error("peers failed"));
    return { peers: {} };
  },
}));
mock.module(import.meta.resolve("../../src/lib/peers/duplicate-detect"), () => ({
  warnDuplicatesAtBoot: () => {},
}));

const original = {
  serve: Bun.serve,
  log: console.log,
  warn: console.warn,
  error: console.error,
  cli: process.env.MAW_CLI,
  ui: process.env.MAW_UI_DIR,
};

Bun.serve = ((opts: any) => {
  serveCalls.push(opts);
  return {
    stop: (_force?: boolean) => {
      if (stopShouldThrow) throw new Error("stop failed");
    },
  } as never;
}) as typeof Bun.serve;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const serverModule = await import("../../src/core/server.ts?core-server-more-coverage-2");
const { startServer, views } = serverModule;
await Promise.resolve();
await Promise.resolve();
const autoStartServeCount = serveCalls.length;
const autoStartLogs = [...logs];

describe("core server remaining isolated coverage", () => {
  beforeEach(() => {
    previousCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "maw-core-server-more-"));
    process.chdir(tmp);
    config = { bind: "127.0.0.1", federationToken: "1234567890123456" };
    serveCalls = [];
    stopShouldThrow = false;
    lifecycleShouldThrow = false;
    sessionsShouldThrow = false;
    connectShouldReject = false;
    pluginLoadShouldThrow = false;
    peersShouldThrow = false;
    watchCallbacks = [];
    pluginReloads = [];
    skipDecisions = [];
    logs = [];
    warns = [];
    errors = [];
    feedListeners.clear();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("module import auto-starts when MAW_CLI is unset", () => {
    expect(serverModule.VERSION).toBeString();
    expect(autoStartServeCount).toBeGreaterThan(0);
    expect(autoStartLogs.some(line => line.includes("maw") && line.includes("serve"))).toBeTrue();
  });

  test("topology serves generated html and view errors become json", async () => {
    mkdirSync(join(tmp, "ψ", "outbox"), { recursive: true });
    writeFileSync(join(tmp, "ψ", "outbox", "fleet-topology.html"), "<h1>fleet</h1>");

    const topology = await views.request("http://local/topology");
    expect(topology.status).toBe(200);
    expect(await topology.text()).toContain("fleet");

    const boom = await views.request("http://local/boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "view exploded" });
  });

  test("startup tolerates tmux, transport, plugin, peer-scan, event-dispatch, reload, and pty-upgrade failure paths", async () => {
    sessionsShouldThrow = true;
    connectShouldReject = true;
    pluginLoadShouldThrow = true;
    peersShouldThrow = new Error("peer cache corrupt");

    await startServer(4789);
    await Promise.resolve();

    expect(errors.join("\n")).toContain("connect failed");
    expect(errors.join("\n")).toContain("failed to init");
    expect(warns.join("\n")).toContain("peer dedup scan skipped: peer cache corrupt");

    const fetch = serveCalls[0].fetch;
    const failedPty = await fetch(new Request("http://local/ws/pty"), upgradeServer(false));
    expect(failedPty.status).toBe(400);
    expect(await failedPty.text()).toBe("WebSocket upgrade failed");

    for (const listener of feedListeners) await listener({ type: "feed" });
    await Promise.resolve();
    expect(warns.join("\n")).toContain("event dispatch failed: dispatch rejected");
  });

  test("plugin reload watcher callback reloads user plugins", async () => {
    await startServer(4790);

    expect(skipDecisions).toEqual([true, false]);
    expect(watchCallbacks).toHaveLength(1);
    await watchCallbacks[0]("changed-plugin.ts");

    expect(logs.join("\n")).toContain("changed-plugin.ts changed");
    expect(pluginReloads).toHaveLength(1);
  });

  test("lifecycle failure rethrows even when server stop also fails", async () => {
    lifecycleShouldThrow = true;
    stopShouldThrow = true;

    await expect(startServer(4791)).rejects.toThrow("lifecycle failed");
  });
});

function upgradeServer(ok: boolean) {
  return {
    upgrade(_req: Request, _opts: unknown) {
      return ok;
    },
  };
}

afterAll(() => {
  Bun.serve = original.serve;
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
  if (original.cli === undefined) delete process.env.MAW_CLI; else process.env.MAW_CLI = original.cli;
  if (original.ui === undefined) delete process.env.MAW_UI_DIR; else process.env.MAW_UI_DIR = original.ui;
  rmSync(uiDir, { recursive: true, force: true });
});
