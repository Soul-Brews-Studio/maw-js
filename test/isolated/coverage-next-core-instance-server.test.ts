import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { mockConfigModule } from "../helpers/mock-config";

process.env.MAW_CLI = "1";

let config: Record<string, unknown> = { port: 3456, env: {}, commands: {}, sessions: {} };
let feedListeners = new Set<(event: unknown) => unknown>();
let serveCalls: any[] = [];

mock.module(import.meta.resolve("../../src/config"), () => mockConfigModule(() => config));
mock.module(import.meta.resolve("../../src/engine"), () => ({
  MawEngine: class {
    setTransportRouter() {}
    handleOpen() {}
    handleMessage() {}
    handleClose() {}
  },
}));
mock.module(import.meta.resolve("../../src/api"), () => ({ api: { handle: () => new Response("api") } }));
mock.module(import.meta.resolve("../../src/api/feed"), () => ({ feedBuffer: [], feedListeners }));
mock.module(import.meta.resolve("../../src/views/index"), () => ({
  mountViews: (views: any) => { views.get("/mounted-next", (c: any) => c.text("mounted-next")); },
}));
mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({ setupTriggerListener: () => {} }));
mock.module(import.meta.resolve("../../src/transports"), () => ({ createTransportRouter: () => ({ connectAll: () => Promise.resolve() }) }));
mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({
  HostExecError: class HostExecError extends Error {},
  capture: async () => "",
  getPaneCommand: async () => "claude",
  hostExec: async () => "",
  isAgentCommand: (cmd: string) => ["claude", "codex", "node"].includes(cmd),
  listSessions: async () => [],
  selectWindow: async () => {},
  sendKeys: async () => {},
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmuxCmd: (...args: Array<string | number>) => `tmux ${args.join(" ")}`,
  tmux: {
    listSessions: async () => [],
    setEnvironment: async () => {},
    hasSession: async () => true,
    run: async () => "",
  },
  Tmux: class {
    async killSession() {}
    async run() { return ""; }
  },
}));
mock.module(import.meta.resolve("../../src/core/transport/pty"), () => ({ handlePtyMessage: () => {}, handlePtyClose: () => {} }));
mock.module(import.meta.resolve("../../src/lib/elysia-auth"), () => ({ setBunServer: () => {} }));
mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runServeLifecycleHooks: async () => {},
  runWakeLifecycleHooks: async () => {},
}));
mock.module(import.meta.resolve("../../src/core/engine-plugin-registry"), () => ({
  dispatchEnginePluginEvent: async () => {},
  findEnginePluginRegistration: () => null,
  hasEnginePluginEventSink: () => false,
  proxyEnginePluginRequest: () => new Response("proxied"),
  startEnginePluginHealthPolling: () => {},
}));
mock.module(import.meta.resolve("../../src/plugins/index"), () => ({
  PluginSystem: class { emit() {}; stats() { return {}; } },
  loadPlugins: async () => {},
  reloadUserPlugins: async () => {},
  watchUserPlugins: () => {},
  registerManifestHooks: async () => {},
}));
mock.module(import.meta.resolve("../../src/views/plugins"), () => ({ pluginsView: () => new Hono() }));
mock.module(import.meta.resolve("../../src/lib/peers/store"), () => ({ loadPeers: () => ({ peers: {} }) }));
mock.module(import.meta.resolve("../../src/lib/peers/duplicate-detect"), () => ({ warnDuplicatesAtBoot: () => {} }));

const instancePid = await import("../../src/cli/instance-pid.ts?coverage-next-core-instance-server");
const serverModule = await import("../../src/core/server.ts?coverage-next-core-instance-server");

const original = {
  home: process.env.MAW_HOME,
  engineUrl: process.env.MAW_ENGINE_URL,
  ui: process.env.MAW_UI_DIR,
  cli: process.env.MAW_CLI,
  kill: process.kill,
  log: console.log,
  errWrite: process.stderr.write,
  serve: Bun.serve,
};

let tempHome = "";
let tempDir = "";
let logs: string[] = [];
let stderrText = "";

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "maw-next-pid-"));
  tempDir = mkdtempSync(join(tmpdir(), "maw-next-server-"));
  process.env.MAW_HOME = tempHome;
  process.env.MAW_CLI = "1";
  logs = [];
  stderrText = "";
  feedListeners = new Set();
  serveCalls = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrText += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  Bun.serve = ((opts: any) => {
    serveCalls.push(opts);
    return { stop: () => {} } as never;
  }) as typeof Bun.serve;
});

afterEach(() => {
  if (original.home === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = original.home;
  if (original.engineUrl === undefined) delete process.env.MAW_ENGINE_URL; else process.env.MAW_ENGINE_URL = original.engineUrl;
  if (original.ui === undefined) delete process.env.MAW_UI_DIR; else process.env.MAW_UI_DIR = original.ui;
  if (original.cli === undefined) delete process.env.MAW_CLI; else process.env.MAW_CLI = original.cli;
  process.kill = original.kill;
  console.log = original.log;
  process.stderr.write = original.errWrite;
  Bun.serve = original.serve;
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
});

describe("coverage next instance pid", () => {
  test("permission-protected pid probes are treated as live", () => {
    writeFileSync(instancePid.pidFile(), "4242");
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(4242);
      expect(signal).toBe(0);
      const err = new Error("permission") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;

    expect(instancePid.serveStatus()).toEqual({ pid: 4242, alive: true, file: instancePid.pidFile() });
    expect(readFileSync(instancePid.pidFile(), "utf-8")).toBe("4242");
  });

  test("plugin status reports unavailable, empty, and fallback registration details", async () => {
    process.kill = (() => true) as typeof process.kill;
    writeFileSync(instancePid.pidFile(), "5151");

    const unavailable = original.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 503 }),
    });
    try {
      await instancePid.printServeStatusWithPlugins(`http://127.0.0.1:${unavailable.port}`);
    } finally {
      unavailable.stop(true);
    }
    expect(logs.join("\n")).toContain("engine plugins: unavailable");

    logs = [];
    const reachable = original.serve({
      port: 0,
      fetch: () => Response.json({ registrations: [] }),
    });
    try {
      await instancePid.printServeStatusWithPlugins(`http://127.0.0.1:${reachable.port}`);
    } finally {
      reachable.stop(true);
    }
    expect(logs.join("\n")).toContain("engine plugins: none");

    logs = [];
    const fallback = original.serve({
      port: 0,
      fetch: () => Response.json({ registrations: [{}] }),
    });
    try {
      await instancePid.printServeStatusWithPlugins(`http://127.0.0.1:${fallback.port}`);
    } finally {
      fallback.stop(true);
    }
    expect(logs.join("\n")).toContain("unknown: unknown-prefix");
  });
});

describe("coverage next core server views", () => {
  test("createViews serves static assets, custom door html, and topology misses", async () => {
    const uiDir = join(tempDir, "ui");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, "asset.txt"), "static-ok");

    const staticViews = serverModule.createViews(uiDir, join(tempDir, "missing-door.html"));
    const asset = await staticViews.request("http://local/asset.txt");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("static-ok");

    const doorPath = join(tempDir, "door.html");
    writeFileSync(doorPath, "<h1>door-ok</h1>");
    const doorViews = serverModule.createViews(join(tempDir, "absent-ui"), doorPath);
    const door = await doorViews.request("http://local/");
    expect(await door.text()).toContain("door-ok");

    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const topology = await doorViews.request("http://local/topology");
      expect(topology.status).toBe(404);
      expect(await topology.text()).toContain("fleet-topology.html not found");
    } finally {
      process.chdir(cwd);
    }
    expect(stderrText).toBe("");
  });

  test("startServer CORS fetch handler covers options, websocket failures, API, and async views", async () => {
    config = { port: 3456, bind: "127.0.0.1", env: {}, commands: {}, sessions: {}, federationToken: "1234567890123456" };
    await serverModule.startServer(4782);

    const fetch = serveCalls[0].fetch;
    const upgradeServer = { upgrade: () => false };

    const options = await fetch(new Request("http://local/mounted-next", { method: "OPTIONS", headers: { origin: "http://caller" } }), upgradeServer);
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("http://caller");

    const ws = await fetch(new Request("http://local/ws"), upgradeServer);
    expect(ws.status).toBe(400);
    expect(await ws.text()).toBe("WebSocket upgrade failed");

    const api = await fetch(new Request("http://local/api/anything"), upgradeServer);
    expect(await api.text()).toBe("api");

    const view = await fetch(new Request("http://local/mounted-next", { headers: { origin: "http://view" } }), upgradeServer);
    expect(await view.text()).toBe("mounted-next");
    expect(view.headers.get("Access-Control-Allow-Origin")).toBe("http://view");
  });
});
