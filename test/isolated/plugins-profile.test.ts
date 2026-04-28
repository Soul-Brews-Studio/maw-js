/**
 * Tests for doProfile from src/commands/shared/plugins-profile.ts.
 * Mocks config to test profile threshold logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedPlugin, PluginManifest } from "../../src/plugin/types";

const tmp = mkdtempSync(join(tmpdir(), "plugins-profile-"));

let savedConfig: any = null;

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
  loadConfig: () => ({ disabledPlugins: [] }),
  saveConfig: (update: any) => { savedConfig = update; },
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

mock.module("../../src/commands/shared/plugins-ui", () => ({
  archiveToTmp: () => {},
  surfaces: () => "",
  shortenHome: (d: string) => d,
  printTable: () => {},
}));

const { doProfile } = await import("../../src/commands/shared/plugins-profile");

function makePlugin(name: string, weight?: number): LoadedPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      weight,
    } as PluginManifest,
    dir: join(tmp, name),
    enabled: true,
  } as LoadedPlugin;
}

beforeEach(() => {
  savedConfig = null;
});

describe("doProfile", () => {
  it("full profile enables all plugins (empty disabled list)", () => {
    const plugins = [makePlugin("a", 10), makePlugin("b", 50), makePlugin("c", 90)];
    doProfile("full", () => plugins);
    expect(savedConfig).toEqual({ disabledPlugins: [] });
  });

  it("core profile disables weight >= 10", () => {
    const plugins = [
      makePlugin("core-plugin", 5),
      makePlugin("standard-plugin", 30),
      makePlugin("heavy-plugin", 90),
    ];
    doProfile("core", () => plugins);
    expect(savedConfig.disabledPlugins).toContain("standard-plugin");
    expect(savedConfig.disabledPlugins).toContain("heavy-plugin");
    expect(savedConfig.disabledPlugins).not.toContain("core-plugin");
  });

  it("standard profile disables weight >= 50", () => {
    const plugins = [
      makePlugin("core-plugin", 5),
      makePlugin("standard-plugin", 30),
      makePlugin("heavy-plugin", 90),
    ];
    doProfile("standard", () => plugins);
    expect(savedConfig.disabledPlugins).toContain("heavy-plugin");
    expect(savedConfig.disabledPlugins).not.toContain("core-plugin");
    expect(savedConfig.disabledPlugins).not.toContain("standard-plugin");
  });

  it("plugins with default weight (undefined → 50) are disabled by core", () => {
    const plugins = [makePlugin("no-weight")]; // weight undefined → defaults to 50
    doProfile("core", () => plugins);
    expect(savedConfig.disabledPlugins).toContain("no-weight");
  });

  it("plugins with default weight (undefined → 50) are disabled by standard", () => {
    const plugins = [makePlugin("no-weight")]; // weight undefined → 50
    doProfile("standard", () => plugins);
    expect(savedConfig.disabledPlugins).toContain("no-weight");
  });

  it("core profile keeps nothing when all plugins are heavy", () => {
    const plugins = [
      makePlugin("a", 50),
      makePlugin("b", 100),
    ];
    doProfile("core", () => plugins);
    expect(savedConfig.disabledPlugins).toHaveLength(2);
  });

  it("no-op when nothing to disable", () => {
    const plugins = [makePlugin("light", 1)];
    doProfile("core", () => plugins);
    // saveConfig should not be called when nothing to disable
    expect(savedConfig).toBeNull();
  });
});
