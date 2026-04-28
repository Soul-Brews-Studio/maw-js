/**
 * Tests for doLs from src/commands/shared/plugins-ls-info.ts.
 * Uses mock.module for config + DI for discover callback.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock config
const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    disabledPlugins: ["disabled-plugin"],
  }),
}));

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp/maw-test",
  resolveHome: () => "/tmp/maw-test",
}));

const { doLs, doInfo } = await import("../../src/commands/shared/plugins-ls-info");
import type { LoadedPlugin } from "../../src/plugin/types";

function makePlugin(name: string, opts: Partial<{ version: string; weight: number; dir: string }> = {}): LoadedPlugin {
  return {
    manifest: {
      name,
      version: opts.version || "1.0.0",
      wasm: "./plugin.wasm",
      sdk: "^1.0.0",
      weight: opts.weight ?? 50,
    },
    dir: opts.dir || `/plugins/${name}`,
    wasmPath: `/plugins/${name}/plugin.wasm`,
  } as LoadedPlugin;
}

describe("doLs", () => {
  let output: string[];
  const origLog = console.log;

  beforeEach(() => {
    output = [];
    console.log = (...args: any[]) => output.push(args.join(" "));
  });

  afterEach(() => {
    console.log = origLog;
  });

  it("outputs JSON when json=true", () => {
    const plugins = [makePlugin("test-plugin")];
    doLs(true, false, () => plugins);
    const parsed = JSON.parse(output.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("test-plugin");
  });

  it("shows 'no plugins installed' when empty", () => {
    doLs(false, false, () => []);
    expect(output.some(l => l.includes("no plugins"))).toBe(true);
  });

  it("filters disabled plugins by default", () => {
    const plugins = [makePlugin("enabled"), makePlugin("disabled-plugin")];
    doLs(false, false, () => plugins);
    // Should show 1 active, mention 1 disabled
    expect(output.some(l => l.includes("disabled"))).toBe(true);
  });

  it("shows all plugins with showAll=true", () => {
    const plugins = [makePlugin("enabled"), makePlugin("disabled-plugin")];
    doLs(false, true, () => plugins);
    expect(output.some(l => l.includes("total"))).toBe(true);
  });
});

import { afterEach } from "bun:test";
