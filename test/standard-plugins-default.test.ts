import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, lstatSync, existsSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { collectStandardPlugins, inspectStandardPluginHealth, installStandardPlugins, STANDARD_PLUGIN_MIN_COUNT } from "../src/commands/shared/standard-plugins";
import { symlinkDirSync } from "../src/core/util/symlink-dir";

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
    const staleTarget = join(root, "stale", "standard-00");
    mkdirSync(staleTarget, { recursive: true });
    symlinkDirSync(staleTarget, join(pluginDir, "standard-00"));
    rmSync(staleTarget, { recursive: true, force: true });
    const valid = join(srcRoot, "src", "commands", "plugins", "standard-03");
    symlinkDirSync(valid, join(pluginDir, "standard-03"));

    const result = await installStandardPlugins({ sourceRoot: srcRoot, pluginDir, fetch: false, log: () => {} });

    expect(result.replaced).toBe(1);
    expect(result.skipped).toBe(1);
    expect(existsSync(join(pluginDir, "standard-00", "plugin.json"))).toBe(true);
    expect(readlinkSync(join(pluginDir, "standard-00")).startsWith("/")).toBe(false);
  });


  test.skipIf(process.platform === "win32")("fetches standard plugin source with git clone plus install so plugin verbs load", async () => {
    const originalUrl = process.env.MAW_STANDARD_PLUGIN_GIT_URL;
    const originalCache = process.env.MAW_STANDARD_PLUGIN_CACHE_DIR;
    const originalSource = process.env.MAW_STANDARD_PLUGIN_SOURCE_ROOT;
    const originalPath = process.env.MAW_JS_PATH;
    const ref = "v0.0.0-fetch";
    const gitRoot = join(root, "remote-maw-js");
    const fetchedPluginDir = join(root, "fetched-plugins");
    const cacheDir = join(root, "source-cache");
    const logs: string[] = [];
    try {
      mkdirSync(join(gitRoot, "src", "vendor", "mpr-plugins"), { recursive: true });
      mkdirSync(join(gitRoot, "packages", "sdk"), { recursive: true });
      mkdirSync(join(gitRoot, "packages", "helper"), { recursive: true });
      writeFileSync(join(gitRoot, "package.json"), JSON.stringify({
        name: "maw-js",
        version: "0.0.0-fetch",
        dependencies: { "@maw-js/sdk": "workspace:*", "@maw-js/helper": "workspace:*" },
        workspaces: ["packages/*"],
      }, null, 2));
      writeFileSync(join(gitRoot, "packages", "sdk", "package.json"), JSON.stringify({ name: "@maw-js/sdk", version: "0.0.0-fetch" }));
      writeFileSync(join(gitRoot, "packages", "sdk", "index.ts"), "export function parseFlags() { return { _: [] }; }\n");
      writeFileSync(join(gitRoot, "packages", "helper", "package.json"), JSON.stringify({ name: "@maw-js/helper", version: "0.0.0-fetch", exports: { ".": "./index.ts" } }));
      writeFileSync(join(gitRoot, "packages", "helper", "index.ts"), "export const helperValue = 'attach-loaded';\n");
      for (let i = 0; i < STANDARD_PLUGIN_MIN_COUNT; i++) {
        const name = i === 0 ? "attach" : `fetched-${String(i).padStart(2, "0")}`;
        const dir = join(gitRoot, "src", "vendor", "mpr-plugins", name);
        mkdirSync(dir, { recursive: true });
        const manifest = {
          name,
          version: "1.0.0",
          sdk: "*",
          entry: "./index.ts",
          ...(name === "attach" ? { cli: { command: "attach", help: "maw attach" } } : {}),
        };
        writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
        if (name === "attach") {
          writeFileSync(join(dir, "index.ts"), "import { helperValue } from '@maw-js/helper'; export default async () => ({ ok: true, output: helperValue });\n");
        } else {
          writeFileSync(join(dir, "index.ts"), "export default async () => ({ ok: true });\n");
        }
      }
      execFileSync("git", ["init", "-q"], { cwd: gitRoot });
      execFileSync("git", ["add", "."], { cwd: gitRoot });
      execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "seed workspace repo"], { cwd: gitRoot });
      execFileSync("git", ["tag", ref], { cwd: gitRoot });

      process.env.MAW_STANDARD_PLUGIN_GIT_URL = `file://${gitRoot}`;
      process.env.MAW_STANDARD_PLUGIN_CACHE_DIR = cacheDir;
      delete process.env.MAW_STANDARD_PLUGIN_SOURCE_ROOT;
      delete process.env.MAW_JS_PATH;

      const result = await installStandardPlugins({ pluginDir: fetchedPluginDir, ref, log: (line) => logs.push(line) });

      expect(result.sourceRoot).toContain(cacheDir);
      expect(result.installed).toBe(STANDARD_PLUGIN_MIN_COUNT);
      expect(inspectStandardPluginHealth(fetchedPluginDir).status).toBe("ok");
      expect(existsSync(join(fetchedPluginDir, "attach", "plugin.json"))).toBe(true);
      const bareMaw = join(root, "bare-maw");
      execFileSync("bun", ["build", "src/cli.ts", "--outfile", bareMaw, "--target=bun", "--external", "@eclipse-zenoh/zenoh-ts"], { cwd: process.cwd(), stdio: "pipe" });
      const load = spawnSync("bun", [bareMaw, "attach"], {
        cwd: root,
        env: { ...process.env, MAW_PLUGINS_DIR: fetchedPluginDir, MAW_QUIET: "1" },
        encoding: "utf8",
      });
      expect(load.status).toBe(0);
      expect(load.stdout).toContain("attach-loaded");
      const logText = logs.join("\n");
      expect(logText).toContain("git clone --depth 1");
      expect(logText).toContain("bun install");
      expect(logText).not.toContain("bun add -g");
    } finally {
      if (originalUrl === undefined) delete process.env.MAW_STANDARD_PLUGIN_GIT_URL; else process.env.MAW_STANDARD_PLUGIN_GIT_URL = originalUrl;
      if (originalCache === undefined) delete process.env.MAW_STANDARD_PLUGIN_CACHE_DIR; else process.env.MAW_STANDARD_PLUGIN_CACHE_DIR = originalCache;
      if (originalSource === undefined) delete process.env.MAW_STANDARD_PLUGIN_SOURCE_ROOT; else process.env.MAW_STANDARD_PLUGIN_SOURCE_ROOT = originalSource;
      if (originalPath === undefined) delete process.env.MAW_JS_PATH; else process.env.MAW_JS_PATH = originalPath;
    }
  }, { timeout: 30_000 });

  test("health flags missing and low plugin directories", () => {
    expect(inspectStandardPluginHealth(join(root, "missing")).status).toBe("missing");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "one"), "not a plugin");
    const health = inspectStandardPluginHealth(pluginDir);
    expect(health.status).toBe("missing");
    expect(health.count).toBe(0);
  });
});
