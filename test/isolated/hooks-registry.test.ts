/**
 * Tests for registerManifestHooks from src/plugins/30_hooks-registry.ts.
 * Mocks discoverPackages to test hook registration logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "hooks-reg-"));

// Track what gets registered
let mockPlugins: any[] = [];

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "test",
    ghqRoot: tmp,
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: () => "",
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/plugin/registry", () => ({
  discoverPackages: () => mockPlugins,
}));

// Use real PluginSystem
const { PluginSystem } = await import("../../src/plugins/10_system");
const { registerManifestHooks } = await import("../../src/plugins/30_hooks-registry");

beforeEach(() => {
  mockPlugins = [];
});

describe("registerManifestHooks", () => {
  it("returns 0 for no plugins", async () => {
    const system = new PluginSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
  });

  it("skips plugins without hooks", async () => {
    mockPlugins = [
      { manifest: { name: "no-hooks" }, kind: "ts", entryPath: "/fake/entry.ts" },
    ];
    const system = new PluginSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
  });

  it("skips non-ts plugins", async () => {
    mockPlugins = [
      {
        manifest: { name: "wasm-plugin", hooks: { on: ["test"] } },
        kind: "wasm",
        entryPath: "/fake/entry.wasm",
      },
    ];
    const system = new PluginSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
  });

  it("skips plugins without entryPath", async () => {
    mockPlugins = [
      {
        manifest: { name: "no-entry", hooks: { on: ["test"] } },
        kind: "ts",
        entryPath: null,
      },
    ];
    const system = new PluginSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
  });

  it("skips plugins whose entry fails to import", async () => {
    mockPlugins = [
      {
        manifest: { name: "bad-import", hooks: { on: ["test"] } },
        kind: "ts",
        entryPath: "/nonexistent/path/to/entry.ts",
      },
    ];
    const system = new PluginSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
  });
});
