/**
 * Tests for `maw plugins ls/info/install/remove`.
 *
 * Uses dependency injection (discover param) for ls/info/remove so tests
 * control the plugin list without touching the real ~/.maw/plugins directory.
 * Install tests use MAW_PLUGIN_HOME env var to redirect the copy target.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cmdPlugins } from "../src/commands/shared/plugins";
import type { LoadedPlugin } from "../src/plugin/types";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makePlugin(
  dir: string,
  name: string,
  extra: Partial<{ version: string; description: string; author: string }> = {},
): LoadedPlugin {
  mkdirSync(dir, { recursive: true });
  const wasmFile = `${name}.wasm`;
  const manifest = {
    name,
    version: extra.version ?? "1.0.0",
    wasm: wasmFile,
    sdk: "^1.0.0",
    description: extra.description ?? "A test plugin",
    author: extra.author,
    cli: { command: name, help: "run the thing" },
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, wasmFile), Buffer.alloc(8));
  return { manifest: manifest as any, dir, wasmPath: join(dir, wasmFile) };
}

// ─── Test setup ────────────────────────────────────────────────────────────

describe("maw plugins CLI", () => {
  let pluginHome: string;
  let logs: string[];
  let errors: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    pluginHome = mkdtempSync(join(tmpdir(), "maw-ph-"));
    process.env.MAW_PLUGIN_HOME = pluginHome;
    logs = [];
    errors = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.MAW_PLUGIN_HOME;
    rmSync(pluginHome, { recursive: true, force: true });
  });

  // ─── ls ──────────────────────────────────────────────────────────────────

  test("ls with no plugins prints empty message", async () => {
    await cmdPlugins("ls", [], { _: [] }, () => []);
    expect(logs[0]).toBe("no plugins installed");
  });

  test("ls --json outputs valid JSON array of plugin summaries", async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "maw-p-"));
    const p = makePlugin(pluginDir, "demo");
    try {
      await cmdPlugins("ls", [], { _: [], "--json": true }, () => [p]);
      const out = JSON.parse(logs[0]);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("demo");
      expect(out[0].version).toBe("1.0.0");
      expect(out[0].surfaces).toBe("cli:demo");
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test("ls grouped output shows plugin name and version", async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "maw-p-"));
    const p = makePlugin(pluginDir, "my-tool");
    try {
      await cmdPlugins("ls", [], { _: [] }, () => [p]);
      const all = logs.join("\n");
      expect(all).toContain("my-tool");
      expect(all).toContain("1.0.0");
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  // ─── info ─────────────────────────────────────────────────────────────────

  test("info on known plugin prints manifest fields", async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "maw-p-"));
    const p = makePlugin(pluginDir, "widget", { author: "Alice" });
    try {
      await cmdPlugins("info", [], { _: ["widget"] }, () => [p]);
      const output = logs.join("\n");
      expect(output).toContain("widget");
      expect(output).toContain("1.0.0");
      expect(output).toContain("sdk:");
      expect(output).toContain("cli:");
      expect(output).toContain("wasm:");
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test("info on unknown plugin exits with error", async () => {
    let exited = false;
    const origExit = process.exit;
    (process as any).exit = () => {
      exited = true;
      throw new Error("exit");
    };
    try {
      await cmdPlugins("info", [], { _: ["ghost"] }, () => []);
    } catch {
      // expected
    } finally {
      (process as any).exit = origExit;
    }
    expect(exited).toBe(true);
    expect(errors.some(e => e.includes("plugin not found: ghost"))).toBe(true);
  });

  // ─── install ─────────────────────────────────────────────────────────────

  test("install copies plugin directory to PLUGIN_HOME/<name>", async () => {
    const src = mkdtempSync(join(tmpdir(), "maw-src-"));
    try {
      makePlugin(src, "installer");
      await cmdPlugins("install", [], { _: [src] });
      expect(existsSync(join(pluginHome, "installer", "plugin.json"))).toBe(true);
      expect(existsSync(join(pluginHome, "installer", "installer.wasm"))).toBe(true);
      expect(logs[0]).toContain("installed installer@1.0.0");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("install duplicate without --force exits with error", async () => {
    const src = mkdtempSync(join(tmpdir(), "maw-src-"));
    let exited = false;
    const origExit = process.exit;
    (process as any).exit = () => {
      exited = true;
      throw new Error("exit");
    };
    try {
      makePlugin(src, "dupl");
      await cmdPlugins("install", [], { _: [src] });
      exited = false;
      await cmdPlugins("install", [], { _: [src] });
    } catch {
      // expected on second install
    } finally {
      (process as any).exit = origExit;
      rmSync(src, { recursive: true, force: true });
    }
    expect(exited).toBe(true);
    expect(errors.some(e => e.includes("already installed"))).toBe(true);
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  test("remove archives plugin dir to /tmp (Nothing Deleted)", async () => {
    const pluginDir = join(pluginHome, "removable");
    const p = makePlugin(pluginDir, "removable");
    await cmdPlugins("remove", [], { _: ["removable"] }, () => [p]);
    expect(existsSync(pluginDir)).toBe(false);
    expect(logs[0]).toContain("removed removable");
  });
});
