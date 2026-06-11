import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const uiDir = mkdtempSync(join(tmpdir(), "maw-ui-present-core-server-"));
process.env.MAW_UI_DIR = uiDir;
delete process.env.MAW_CLI;

let config: Record<string, any> = {};
let serveCalls: any[] = [];
let stoppedPorts: Array<{ port: number; force?: boolean }> = [];
let serveThrowOnCall: number | null = null;
let stopShouldThrow = false;
let lifecycleShouldThrow = false;
let sessionsShouldThrow = false;
let connectShouldReject = false;
let pluginLoadShouldThrow = false;
let peersShouldThrow: unknown = false;
let watchCallbacks: Array<(changedFile: string) => unknown> = [];
let pluginReloads: unknown[][] = [];
let pluginLoads: unknown[][] = [];
let projectPluginDirs: string[] = [];
let unloadedScopes: string[] = [];
let reloadMarks = 0;
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
  unloadScope(scope: string) { unloadedScopes.push(scope); }
  _markReloaded() { reloadMarks += 1; }
}

mock.module(import.meta.resolve("../../src/engine"), () => ({ MawEngine: FakeEngine }));
mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/api"), () => ({
  api: { handle: () => new Response("api") },
}));
mock.module(import.meta.resolve("../../src/api/feed"), () => ({
  feedBuffer,
  feedListeners,
  pushFeedEvent: (event: unknown) => { feedBuffer.push(event); for (const listener of feedListeners) listener(event); },
  pushFeedEventWithDeps: (event: unknown) => { feedBuffer.push(event); for (const listener of feedListeners) listener(event); },
}));
mock.module(import.meta.resolve("../../src/views/index"), () => ({
  mountViews: (views: Hono) => { views.get("/boom", () => { throw new Error("view exploded"); }); },
}));
mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({
  setupTriggerListener: () => {},
}));
mock.module(import.meta.resolve("../../src/transports"), () => ({
  createScopedTransportRouter: () => ({
    connectAll: () => connectShouldReject ? Promise.reject(new Error("connect rejected")) : Promise.resolve(),
  }),
  createTransportRouter: () => ({
    connectAll: () => connectShouldReject ? Promise.reject(new Error("connect rejected")) : Promise.resolve(),
  }),
  getTransportRouter: () => null,
  resetTransportRouter: () => {},
}));
mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({
  hostExec: async () => "",
  HostExecError: class HostExecError extends Error {},
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  getPaneCommand: async () => "",
  isAgentCommand: () => false,
  listSessions: async () => {
    if (sessionsShouldThrow) throw new Error("tmux unavailable");
    return [];
  },
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmuxCmd: () => "tmux-test",
  resolveSocket: () => [],
  tmux: { run: async () => "", listSessions: async () => [] },
  withPaneLock: async (fn: () => unknown) => await fn(),
  splitWindowLocked: async () => undefined,
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
  Tmux: class { async killSession(_name: string) {} },
}));
mock.module(import.meta.resolve("../../src/core/transport/pty"), () => ({
  handlePtyMessage: () => {},
  handlePtyClose: () => {},
  sweepOrphanPtySessions: async () => ({ killed: [], checked: 0 }),
}));
mock.module(import.meta.resolve("../../src/lib/elysia-auth"), () => ({
  isProtected: () => false,
  setBunServer: () => {},
}));
mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runServeLifecycleHooks: async () => {
    if (lifecycleShouldThrow) throw new Error("lifecycle failed");
  },
  runWakeLifecycleHooks: async () => {},
  runSleepLifecycleHooks: async () => {},
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
  loadPlugins: async (...args: unknown[]) => {
    pluginLoads.push(args);
    if (pluginLoadShouldThrow) throw new Error("plugin load failed");
  },
  reloadUserPlugins: async (...args: unknown[]) => { pluginReloads.push(args); },
  watchUserPlugins: (_dir: string, cb: (changedFile: string) => unknown) => { watchCallbacks.push(cb); },
  registerManifestHooks: async () => {},
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
  if (serveThrowOnCall === serveCalls.length) {
    throw Object.assign(new Error("TLS port busy"), { code: "EADDRINUSE", syscall: "listen" });
  }
  return {
    stop: (force?: boolean) => {
      stoppedPorts.push({ port: opts.port, force });
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
    stoppedPorts = [];
    serveThrowOnCall = null;
    stopShouldThrow = false;
    lifecycleShouldThrow = false;
    sessionsShouldThrow = false;
    connectShouldReject = false;
    pluginLoadShouldThrow = false;
    peersShouldThrow = false;
    watchCallbacks = [];
    pluginReloads = [];
    pluginLoads = [];
    projectPluginDirs = [];
    unloadedScopes = [];
    reloadMarks = 0;
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

  test("startup tolerates tmux, transport, plugin, event-dispatch, reload, and pty-upgrade failure paths", async () => {
    sessionsShouldThrow = true;
    connectShouldReject = true;
    pluginLoadShouldThrow = true;
    peersShouldThrow = new Error("peer cache corrupt");

    await startServer(4789);
    await Promise.resolve();

    expect(errors.join("\n")).toContain("connect failed");
    expect(errors.join("\n")).toContain("failed to init");
    // Peer dedup scan warnings moved to serve-peer-startup-warnings; isolated
    // server.ts tests do not execute lifecycle plugins. The plugin standalone
    // test covers the corrupt peer-cache warning.
    expect(warns.join("\n")).not.toContain("peer dedup scan skipped");

    const fetch = serveCalls[0].fetch;
    const failedPty = await fetch(new Request("http://local/ws/pty"), upgradeServer(false));
    expect(failedPty.status).toBe(400);
    expect(await failedPty.text()).toBe("WebSocket upgrade failed");

    for (const listener of feedListeners) await listener({ type: "feed" });
    await Promise.resolve();
    expect(warns.join("\n")).toContain("event dispatch failed: dispatch rejected");
  });

  test("missing federation token warning is plugin-owned after extraction", async () => {
    config = { peers: ["http://peer.local:3456"] };

    await startServer(4792);
    await startServer(4793);

    const joined = warns.join("\n");
    // Missing-token warning dedupe moved to serve-peer-startup-warnings; this
    // isolated server.ts test mocks lifecycle hooks and therefore should not
    // expect plugin-owned warnings.
    expect(joined).not.toContain("peers configured but no federationToken set");
    expect(joined).not.toContain("exposed to network WITHOUT authentication");
  });

  test("plugin reload watcher callback reloads user plugins", async () => {
    await startServer(4790);

    expect(skipDecisions).toEqual([true, false]);
    expect(watchCallbacks).toHaveLength(1);
    await watchCallbacks[0]("changed-plugin.ts");

    expect(logs.join("\n")).toContain("changed-plugin.ts changed");
    expect(pluginReloads).toHaveLength(1);
  });

  test("server loads and watches project-local plugin directories", async () => {
    projectPluginDirs = [join(tmp, "packages", "app", ".maw", "plugins"), join(tmp, ".maw", "plugins")];
    const cwd = join(tmp, "packages", "app", "src");
    for (const dir of projectPluginDirs) mkdirSync(dir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);

    await startServer(4792);

    const initialLoads = pluginLoads.map((args) => args.slice(1));
    expect(String(initialLoads[0][0])).toContain("plugins/builtin");
    expect(initialLoads[0][1]).toBe("builtin");
    expect(String(initialLoads[1][0])).toContain("plugins");
    expect(initialLoads[1][1]).toBe("user");
    expect(initialLoads.slice(2).map((args) => args[1])).toEqual(["project", "project"]);
    expect(String(initialLoads[2][0])).toContain("packages/app/.maw/plugins");
    expect(String(initialLoads[3][0])).toContain(".maw/plugins");
    expect(watchCallbacks).toHaveLength(3);

    await watchCallbacks[1]("local-plugin.ts");

    expect(logs.join("\n")).toContain("reloading project plugins (local-plugin.ts changed)");
    expect(unloadedScopes).toEqual(["project"]);
    const reloadedProjectLoads = pluginLoads.slice(-2).map((args) => args.slice(1));
    expect(reloadedProjectLoads.map((args) => args[1])).toEqual(["project", "project"]);
    expect(reloadedProjectLoads.map((args) => args[2])).toEqual([true, true]);
    expect(String(reloadedProjectLoads[0][0])).toContain("packages/app/.maw/plugins");
    expect(String(reloadedProjectLoads[1][0])).toContain(".maw/plugins");
    expect(reloadMarks).toBe(1);
  });

  test("lifecycle failure rethrows even when server stop also fails", async () => {
    lifecycleShouldThrow = true;
    stopShouldThrow = true;

    await expect(startServer(4791)).rejects.toThrow("lifecycle failed");
  });

  test("TLS bind failure stops the already-started HTTP server and fails loud", async () => {
    const cert = join(tmp, "cert.pem");
    const key = join(tmp, "key.pem");
    writeFileSync(cert, "fake-cert");
    writeFileSync(key, "fake-key");
    config = { bind: "127.0.0.1", tls: { cert, key } };
    serveThrowOnCall = 2;

    await expect(startServer(4800)).rejects.toThrow("maw serve TLS port 4801 is already in use");

    expect(serveCalls.map(call => call.port)).toEqual([4800, 4801]);
    expect(stoppedPorts).toEqual([{ port: 4800, force: true }]);
    expect(errors.join("\n")).toContain("maw serve cannot start: 127.0.0.1:4801 is already in use");
  });

  test("stopping a TLS-enabled server also stops the TLS listener", async () => {
    const cert = join(tmp, "cert.pem");
    const key = join(tmp, "key.pem");
    writeFileSync(cert, "fake-cert");
    writeFileSync(key, "fake-key");
    config = { bind: "127.0.0.1", tls: { cert, key } };

    const server = await startServer(4802) as { stop: (force?: boolean) => void };
    server.stop(true);

    expect(serveCalls.map(call => call.port)).toEqual([4802, 4803]);
    expect(stoppedPorts).toEqual([{ port: 4802, force: true }, { port: 4803, force: true }]);
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
