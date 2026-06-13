import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync, lstatSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { collectStandardPlugins, inspectStandardPluginHealth, installStandardPlugins, STANDARD_PLUGIN_MIN_COUNT } from "../src/commands/shared/standard-plugins";

let root = "";
let srcRoot = "";
let pluginDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-standard-plugins-"));
  srcRoot = join(root, "maw-js");
  pluginDir = join(root, "plugins");
  mkdirSync(join(srcRoot, "src", "commands", "plugins"), { recursive: true });
  mkdirSync(join(srcRoot, "src", "vendor", "mpr-plugins"), { recursive: true });
  mkdirSync(join(srcRoot, "src", "vendor-plugins"), { recursive: true });
  writeFileSync(join(srcRoot, "package.json"), JSON.stringify({ name: "maw-js", version: "0.0.0-test" }));
  for (let i = 0; i < STANDARD_PLUGIN_MIN_COUNT; i++) {
    const lane = i % 3 === 0 ? ["src", "commands", "plugins"] : i % 3 === 1 ? ["src", "vendor", "mpr-plugins"] : ["src", "vendor-plugins"];
    const name = `standard-${String(i).padStart(2, "0")}`;
    const dir = join(srcRoot, ...lane, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0", sdk: "^1.0.0" }));
    writeFileSync(join(dir, "index.ts"), "export default async () => ({ ok: true });\n");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("standard plugin bootstrap", () => {
  test("collects canonical standard plugins from all maw-js source lanes", () => {
    const plugins = collectStandardPlugins(srcRoot);
    expect(plugins).toHaveLength(STANDARD_PLUGIN_MIN_COUNT);
    expect(plugins[0]?.name).toBe("standard-00");
  });

  test("installs relative symlinks into an empty plugin dir", async () => {
    const logs: string[] = [];
    const result = await installStandardPlugins({ sourceRoot: srcRoot, pluginDir, fetch: false, log: (line) => logs.push(line) });

    expect(result.installed).toBe(STANDARD_PLUGIN_MIN_COUNT);
    expect(result.replaced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(inspectStandardPluginHealth(pluginDir).status).toBe("ok");
    const link = join(pluginDir, "standard-00");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link).startsWith("/")).toBe(false);
    expect(existsSync(join(link, "plugin.json"))).toBe(true);
    expect(logs.join("\n")).toContain("installed standard plugins");
  });

  test("replaces dangling symlinks and keeps valid plugins by default", async () => {
    mkdirSync(pluginDir, { recursive: true });
    symlinkSync("/foreign/m5/path/standard-00", join(pluginDir, "standard-00"), "dir");
    const valid = join(srcRoot, "src", "commands", "plugins", "standard-03");
    symlinkSync(valid, join(pluginDir, "standard-03"), "dir");

    const result = await installStandardPlugins({ sourceRoot: srcRoot, pluginDir, fetch: false, log: () => {} });

    expect(result.replaced).toBe(1);
    expect(result.skipped).toBe(1);
    expect(existsSync(join(pluginDir, "standard-00", "plugin.json"))).toBe(true);
    expect(readlinkSync(join(pluginDir, "standard-00")).startsWith("/")).toBe(false);
  });

  test("health flags missing and low plugin directories", () => {
    expect(inspectStandardPluginHealth(join(root, "missing")).status).toBe("missing");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "one"), "not a plugin");
    const health = inspectStandardPluginHealth(pluginDir);
    expect(health.status).toBe("missing");
    expect(health.count).toBe(0);
  });
});
