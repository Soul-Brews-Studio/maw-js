import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

process.env.MAW_CLI = "1";

const repoRoot = resolve(import.meta.dir, "../..");
const snapshotPath = join(repoRoot, "test/snapshots/serve-routes.snap");
const servePluginNames = [
  "serve-agents",
  "serve-debug",
  "serve-federation",
  "serve-identity",
  "serve-triggers",
  "serve-triggers-mutate",
  "serve-views",
  "serve-worktrees",
  "serve-ws",
];

const original = {
  serve: Bun.serve,
  cwd: process.cwd(),
  cli: process.env.MAW_CLI,
  home: process.env.HOME,
  mawHome: process.env.MAW_HOME,
  pluginsDir: process.env.MAW_PLUGINS_DIR,
  uiDir: process.env.MAW_UI_DIR,
  warnState: process.env.MAW_WARN_STATE_FILE,
};

let root = "";
let serveCalls: Array<Record<string, unknown>> = [];

function linkServePlugins(pluginDir: string): void {
  mkdirSync(pluginDir, { recursive: true });
  for (const name of servePluginNames) {
    const source = join(repoRoot, "src/vendor/mpr-plugins", name);
    const target = join(pluginDir, name);
    if (!existsSync(source)) throw new Error(`missing serve plugin fixture: ${source}`);
    symlinkSync(source, target, "dir");
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-serve-routes-"));
  const pluginDir = join(root, "plugins");
  linkServePlugins(pluginDir);
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "cwd"), { recursive: true });
  writeFileSync(join(root, "cwd", ".maw-root"), "");
  process.chdir(join(root, "cwd"));
  process.env.MAW_CLI = "1";
  process.env.HOME = join(root, "home");
  process.env.MAW_HOME = join(root, "home", ".maw");
  process.env.MAW_PLUGINS_DIR = pluginDir;
  process.env.MAW_UI_DIR = join(root, "missing-ui");
  process.env.MAW_WARN_STATE_FILE = join(root, "warnings.json");
  serveCalls = [];
  (Bun as unknown as { serve: typeof Bun.serve }).serve = ((options: Record<string, unknown>) => {
    serveCalls.push(options);
    return {
      port: options.port ?? 0,
      hostname: options.hostname ?? "127.0.0.1",
      stop: () => undefined,
    } as ReturnType<typeof Bun.serve>;
  }) as typeof Bun.serve;
});

afterEach(() => {
  (Bun as unknown as { serve: typeof Bun.serve }).serve = original.serve;
  process.chdir(original.cwd);
  if (original.cli === undefined) delete process.env.MAW_CLI; else process.env.MAW_CLI = original.cli;
  if (original.home === undefined) delete process.env.HOME; else process.env.HOME = original.home;
  if (original.mawHome === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = original.mawHome;
  if (original.pluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR; else process.env.MAW_PLUGINS_DIR = original.pluginsDir;
  if (original.uiDir === undefined) delete process.env.MAW_UI_DIR; else process.env.MAW_UI_DIR = original.uiDir;
  if (original.warnState === undefined) delete process.env.MAW_WARN_STATE_FILE; else process.env.MAW_WARN_STATE_FILE = original.warnState;
  if (root) rmSync(root, { recursive: true, force: true });
  mock.restore();
});

mock.module(import.meta.resolve("../../src/core/runtime/trigger-listener"), () => ({ setupTriggerListener: () => {} }));
mock.module(import.meta.resolve("../../src/transports"), () => ({
  createScopedTransportRouter: () => ({ connectAll: () => Promise.resolve(), onMessage: () => {} }),
  createTransportRouter: () => ({ connectAll: () => Promise.resolve(), onMessage: () => {} }),
  getTransportRouter: () => null,
  resetTransportRouter: () => {},
}));
mock.module(import.meta.resolve("../../src/core/dispatch-engine"), () => ({ startDispatchEngine: () => {}, getDispatchEngine: () => null }));
mock.module(import.meta.resolve("../../src/plugins/index"), () => ({
  PluginSystem: class { emit() {}; stats() { return { loaded: 0, scopes: {} }; } },
  loadPlugins: async () => {},
  reloadUserPlugins: async () => {},
  watchUserPlugins: () => {},
  registerManifestHooks: async () => {},
}));

describe("maw serve route golden master (#2617)", () => {
  test("boots serve and snapshots HTTP, WS, proxy, fallback, and middleware routes", async () => {
    const {
      SERVE_ROUTE_SNAPSHOT_SYMBOL,
      formatServeRouteSnapshot,
      startServer,
    } = await import("../../src/core/server.ts?serve-routes-golden-master");

    const server = await startServer(0, { verbosity: 0 });
    expect(serveCalls).toHaveLength(1);

    const snapshot = (server as unknown as Record<symbol, unknown>)[SERVE_ROUTE_SNAPSHOT_SYMBOL];
    expect(Array.isArray(snapshot)).toBe(true);
    const text = `${formatServeRouteSnapshot(snapshot as never)}\n`;

    expect(text).toContain("WS /ws -> serve ws registry");
    expect(text).toContain("WS /ws/pty -> serve ws registry");
    expect(text).toContain("WS /ws/tmux -> serve ws registry");
    expect(text).toContain("MIDDLEWARE 01 * -> CORS preflight");
    expect(text).toContain("PROXY /api/{engine-plugin-prefix}/* -> dynamic engine plugin proxy");
    if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(snapshotPath, text);
    expect(text).toBe(readFileSync(snapshotPath, "utf8"));
  });
});
