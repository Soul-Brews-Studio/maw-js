import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearBunGlobalResolverState,
  healBrokenPluginSymlinks,
  isPluginSourceDir,
  linkBundledPluginRoots,
} from "../src/cli/cmd-update";

const roots: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `maw-update-${label}-`));
  roots.push(dir);
  return dir;
}

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("cmd-update helper coverage", () => {
  test("clearBunGlobalResolverState removes maw resolver pins, locks, and cache entries, then restores package.json", () => {
    const home = tmpRoot("resolver");
    const bunGlobal = join(home, ".bun", "install", "global");
    const cacheDir = join(home, ".bun", "install", "cache");
    mkdirp(bunGlobal);
    mkdirp(cacheDir);

    const packageJson = join(bunGlobal, "package.json");
    const original = {
      dependencies: {
        "maw-js": "github:Soul-Brews-Studio/maw-js#old",
        maw: "github:Soul-Brews-Studio/maw-js#older",
        hono: "^4.0.0",
      },
      devDependencies: { keep: "1.0.0" },
    };
    writeFileSync(packageJson, JSON.stringify(original, null, 2) + "\n");
    writeFileSync(join(bunGlobal, "bun.lock"), "old lock");
    writeFileSync(join(bunGlobal, "bun.lockb"), "old binary lock");
    mkdirp(join(cacheDir, "maw-js-stale"));
    mkdirp(join(cacheDir, "other-package"));

    const restore = clearBunGlobalResolverState(home);

    const cleaned = JSON.parse(readFileSync(packageJson, "utf-8"));
    expect(cleaned.dependencies).toEqual({ hono: "^4.0.0" });
    expect(cleaned.devDependencies).toEqual({ keep: "1.0.0" });
    expect(existsSync(join(bunGlobal, "bun.lock"))).toBe(false);
    expect(existsSync(join(bunGlobal, "bun.lockb"))).toBe(false);
    expect(existsSync(join(cacheDir, "maw-js-stale"))).toBe(false);
    expect(existsSync(join(cacheDir, "other-package"))).toBe(true);

    restore();

    expect(JSON.parse(readFileSync(packageJson, "utf-8"))).toEqual(original);
  });

  test("clearBunGlobalResolverState is best-effort when package metadata is absent", () => {
    const home = tmpRoot("missing");
    const bunGlobal = join(home, ".bun", "install", "global");
    mkdirp(bunGlobal);
    writeFileSync(join(bunGlobal, "bun.lock"), "old lock");

    const restore = clearBunGlobalResolverState(home);

    expect(existsSync(join(bunGlobal, "bun.lock"))).toBe(false);
    expect(() => restore()).not.toThrow();
  });

  test("isPluginSourceDir recognizes plugin.json and index.ts roots only", () => {
    const root = tmpRoot("source-dir");
    const withManifest = join(root, "with-manifest");
    const withIndex = join(root, "with-index");
    const empty = join(root, "empty");
    mkdirp(withManifest);
    mkdirp(withIndex);
    mkdirp(empty);
    writeFileSync(join(withManifest, "plugin.json"), "{}");
    writeFileSync(join(withIndex, "index.ts"), "export default {};");

    expect(isPluginSourceDir(withManifest)).toBe(true);
    expect(isPluginSourceDir(withIndex)).toBe(true);
    expect(isPluginSourceDir(empty)).toBe(false);
  });

  test("linkBundledPluginRoots links plugin source dirs, ignores non-sources, and is idempotent", () => {
    const root = tmpRoot("link");
    const pluginDir = join(root, "plugins");
    const bundled = join(root, "bundled");
    mkdirp(pluginDir);
    mkdirp(join(bundled, "alpha"));
    mkdirp(join(bundled, "beta"));
    mkdirp(join(bundled, "not-a-plugin"));
    writeFileSync(join(bundled, "alpha", "plugin.json"), "{}");
    writeFileSync(join(bundled, "beta", "index.ts"), "export default {};");
    writeFileSync(join(bundled, "not-a-plugin", "README.md"), "no command");

    expect(linkBundledPluginRoots(pluginDir, [join(root, "missing"), bundled])).toBe(2);
    expect(lstatSync(join(pluginDir, "alpha")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(pluginDir, "beta")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(pluginDir, "not-a-plugin"))).toBe(false);

    expect(linkBundledPluginRoots(pluginDir, [bundled])).toBe(0);
  });

  test("linkBundledPluginRoots replaces stale broken symlink destinations before linking", () => {
    const root = tmpRoot("stale-link");
    const pluginDir = join(root, "plugins");
    const bundled = join(root, "bundled");
    mkdirp(pluginDir);
    mkdirp(join(bundled, "alpha"));
    writeFileSync(join(bundled, "alpha", "plugin.json"), "{}");
    symlinkSync(join(root, "gone", "alpha"), join(pluginDir, "alpha"));

    expect(existsSync(join(pluginDir, "alpha"))).toBe(false);
    expect(linkBundledPluginRoots(pluginDir, [bundled])).toBe(1);
    expect(existsSync(join(pluginDir, "alpha", "plugin.json"))).toBe(true);
  });

  test("healBrokenPluginSymlinks relinks recoverable stale plugins and prunes missing ones", () => {
    const root = tmpRoot("heal");
    const pluginDir = join(root, "plugins");
    const bundled = join(root, "bundled");
    mkdirp(pluginDir);
    mkdirp(join(bundled, "recover"));
    mkdirp(join(bundled, "live"));
    writeFileSync(join(bundled, "recover", "plugin.json"), "{}");
    writeFileSync(join(bundled, "live", "plugin.json"), "{}");
    symlinkSync(join(root, "gone", "recover"), join(pluginDir, "recover"));
    symlinkSync(join(root, "gone", "prune"), join(pluginDir, "prune"));
    symlinkSync(join(bundled, "live"), join(pluginDir, "live"));

    const result = healBrokenPluginSymlinks(pluginDir, [bundled]);

    expect(result).toEqual({ healed: 1, pruned: 1 });
    expect(existsSync(join(pluginDir, "recover", "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "prune"))).toBe(false);
    expect(existsSync(join(pluginDir, "live", "plugin.json"))).toBe(true);
  });
});
