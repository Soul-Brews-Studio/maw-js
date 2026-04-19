/**
 * #641 — On `maw plugin install <dir> --link`, the installer arranges
 * `maw-js/sdk` resolution automatically by planting `node_modules/maw-js`
 * in the plugin source directory (symlinked to the running maw-js root).
 *
 * These tests exercise `ensurePluginMawJsLink` directly (unit) plus an
 * end-to-end path via `cmdPluginInstall` that asserts the link lands.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import {
  cmdPluginInstall,
  ensurePluginMawJsLink,
} from "../../src/commands/plugins/plugin/install-impl";
import { __resetDiscoverStateForTests, resetDiscoverCache } from "../../src/plugin/registry";

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;
let origMawJsPath: string | undefined;

function tmpDir(prefix = "maw-autolink-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

function buildFixture(): { dir: string } {
  const dir = tmpDir("maw-fixture-");
  const src = "export default () => ({ ok: true });\n";
  const sha = "sha256:" + createHash("sha256").update(src).digest("hex");
  writeFileSync(join(dir, "index.js"), src);
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      name: "hello", version: "0.1.0", sdk: "*",
      target: "js", capabilities: [],
      artifact: { path: "./index.js", sha256: sha },
    }, null, 2),
  );
  return { dir };
}

/** A minimal fake maw-js root — a directory with package.json#name="maw-js".
 *  We override $MAW_JS_PATH so the resolver picks this up instead of the
 *  real running repo (keeps the test hermetic). */
function fakeMawJsRoot(): string {
  const root = tmpDir("fake-maw-js-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "maw-js", version: "0.0.0" }, null, 2),
  );
  return root;
}

beforeEach(() => {
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  origMawJsPath = process.env.MAW_JS_PATH;
  const home = tmpDir("maw-home-");
  process.env.MAW_PLUGINS_DIR = join(home, "plugins");
  process.env.MAW_PLUGINS_LOCK = join(home, "plugins.lock");
  __resetDiscoverStateForTests();
  resetDiscoverCache();
});

afterEach(() => {
  if (origPluginsDir !== undefined) process.env.MAW_PLUGINS_DIR = origPluginsDir;
  else delete process.env.MAW_PLUGINS_DIR;
  if (origPluginsLock !== undefined) process.env.MAW_PLUGINS_LOCK = origPluginsLock;
  else delete process.env.MAW_PLUGINS_LOCK;
  if (origMawJsPath !== undefined) process.env.MAW_JS_PATH = origMawJsPath;
  else delete process.env.MAW_JS_PATH;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("ensurePluginMawJsLink — #641", () => {
  test("creates node_modules/maw-js symlink pointing at MAW_JS_PATH", () => {
    const mawJs = fakeMawJsRoot();
    process.env.MAW_JS_PATH = mawJs;
    const plugin = tmpDir("plugin-src-");

    ensurePluginMawJsLink(plugin);

    const link = join(plugin, "node_modules", "maw-js");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(mawJs));
  });

  test("idempotent — second call on an already-correct symlink is a no-op", () => {
    const mawJs = fakeMawJsRoot();
    process.env.MAW_JS_PATH = mawJs;
    const plugin = tmpDir("plugin-src-");

    ensurePluginMawJsLink(plugin);
    const first = readlinkSync(join(plugin, "node_modules", "maw-js"));
    ensurePluginMawJsLink(plugin);
    const second = readlinkSync(join(plugin, "node_modules", "maw-js"));

    expect(second).toBe(first);
  });

  test("replaces a stale symlink pointing elsewhere", () => {
    const mawJs = fakeMawJsRoot();
    const stale = tmpDir("stale-maw-js-");
    process.env.MAW_JS_PATH = mawJs;
    const plugin = tmpDir("plugin-src-");
    const nm = join(plugin, "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(stale, join(nm, "maw-js"), "dir");

    ensurePluginMawJsLink(plugin);

    expect(realpathSync(join(nm, "maw-js"))).toBe(realpathSync(mawJs));
  });

  test("leaves a real directory alone (operator intent wins)", () => {
    const mawJs = fakeMawJsRoot();
    process.env.MAW_JS_PATH = mawJs;
    const plugin = tmpDir("plugin-src-");
    const nm = join(plugin, "node_modules");
    mkdirSync(join(nm, "maw-js"), { recursive: true });
    writeFileSync(join(nm, "maw-js", "marker.txt"), "real");

    ensurePluginMawJsLink(plugin);

    const t = lstatSync(join(nm, "maw-js"));
    expect(t.isSymbolicLink()).toBe(false);
    expect(t.isDirectory()).toBe(true);
    expect(existsSync(join(nm, "maw-js", "marker.txt"))).toBe(true);
  });

  test("no MAW_JS_PATH → falls back to the running maw-js root", () => {
    delete process.env.MAW_JS_PATH;
    const plugin = tmpDir("plugin-src-");

    ensurePluginMawJsLink(plugin);

    const link = join(plugin, "node_modules", "maw-js");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Target should resolve to a directory whose package.json declares "maw-js".
    const target = realpathSync(link);
    const pkg = JSON.parse(
      require("fs").readFileSync(join(target, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("maw-js");
  });
});

describe("cmdPluginInstall --link — #641 e2e", () => {
  test("planting succeeds after install and survives a re-install", async () => {
    const mawJs = fakeMawJsRoot();
    process.env.MAW_JS_PATH = mawJs;
    const { dir } = buildFixture();

    await cmdPluginInstall([dir, "--link"]);

    const link = join(dir, "node_modules", "maw-js");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(mawJs));

    // Re-install with --force should preserve the link.
    await cmdPluginInstall([dir, "--link", "--force"]);
    expect(realpathSync(link)).toBe(realpathSync(mawJs));
  });
});
