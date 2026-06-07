import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
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
let apiPaths: string[] = [];
let proxiedPaths: string[] = [];
let lifecyclePayloads: unknown[] = [];
let healthPolls = 0;
let tmp = "";

class FakeEngine {
  setTransportRouter() { engineCalls.push("router"); }
  handleOpen() { engineCalls.push("open"); }
  handleMessage() { engineCalls.push("message"); }
  handleClose() { engineCalls.push("close"); }
}

mock.module(import.meta.resolve("../../src/engine"), () => ({ MawEngine: FakeEngine }));
mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/api"), () => ({
  api: { handle: (req: Request) => { apiPaths.push(new URL(req.url).pathname); return new Response("api"); } },
}));
mock.module(import.meta.resolve("../../src/api/feed"), () => ({ feedBuffer: [], feedListeners: new Set() }));
mock.module(import.meta.resolve("../../src/views/index"), () => ({
  mountViews: (views: Hono) => { views.get("/throws", () => { throw new Error("view failed"); }); },
}));
mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({ setupTriggerListener: () => {} }));
mock.module(import.meta.resolve("../../src/transports"), () => ({
  createTransportRouter: () => ({ connectAll: () => Promise.resolve() }),
}));
mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({ listSessions: async () => sessions }));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  Tmux: class { async killSession(name: string) { killed.push(name); } },
}));
mock.module(import.meta.resolve("../../src/core/transport/pty"), () => ({
  handlePtyMessage: (...args: unknown[]) => { ptyMessages.push(args); },
  handlePtyClose: (...args: unknown[]) => { ptyCloses.push(args); },
}));
mock.module(import.meta.resolve("../../src/lib/elysia-auth"), () => ({ setBunServer: () => {} }));
mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runServeLifecycleHooks: async (payload: unknown) => { lifecyclePayloads.push(payload); },
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
mock.module(import.meta.resolve("../../src/views/plugins"), () => ({ pluginsView: () => new Hono() }));
mock.module(import.meta.resolve("../../src/lib/peers/store"), () => ({ loadPeers: () => ({ peers: {} }) }));
mock.module(import.meta.resolve("../../src/lib/peers/duplicate-detect"), () => ({ warnDuplicatesAtBoot: () => {} }));

const { createViews, startServer } = await import("../../src/core/server.ts?coverage-core-shared-server");

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
  apiPaths = [];
  proxiedPaths = [];
  lifecyclePayloads = [];
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
    await startServer(4910);

    expect(killed).toEqual(["maw-pty-stale", "sender-view"]);
    expect(engineCalls).toContain("router");
    expect(lifecyclePayloads).toEqual([{ port: 4910, httpUrl: "http://localhost:4910", wsUrl: "ws://localhost:4910/ws", hostname: "127.0.0.1" }]);
    expect(healthPolls).toBe(1);

    const ws = serveCalls[0].websocket;
    const normal = { data: {} };
    const pty = { data: { mode: "pty" } };
    ws.open(normal);
    ws.open(pty);
    ws.message(normal, "hello");
    ws.message(pty, "resize");
    ws.close(normal);
    ws.close(pty);
    expect(engineCalls).toEqual(["router", "open", "message", "close"]);
    expect(ptyMessages).toHaveLength(1);
    expect(ptyCloses).toHaveLength(1);

    const fetch = serveCalls[0].fetch;
    const options = await fetch(new Request("http://local/anything", { method: "OPTIONS", headers: { origin: "http://origin.test" } }), upgradeServer(true));
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("http://origin.test");
    expect(await (await fetch(new Request("http://local/api/engine"), upgradeServer(true))).text()).toBe("proxied");
    expect(proxiedPaths).toEqual(["/api/engine"]);
    expect(await (await fetch(new Request("http://local/api/ordinary"), upgradeServer(true))).text()).toBe("api");
    expect(apiPaths).toEqual(["/api/ordinary"]);

    const ptyUpgrade = upgradeServer(true);
    expect(await fetch(new Request("http://local/ws/pty"), ptyUpgrade)).toBeUndefined();
    expect(ptyUpgrade.upgrades[0].data.mode).toBe("pty");
    const failedUpgrade = await fetch(new Request("http://local/ws"), upgradeServer(false));
    expect(failedUpgrade.status).toBe(400);
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
