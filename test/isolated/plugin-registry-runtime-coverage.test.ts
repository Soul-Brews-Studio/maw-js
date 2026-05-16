/**
 * Runtime coverage for src/plugin/registry.ts discovery wiring. Helper modules
 * are mocked so the test can drive semver, hash, dev-mode, verbosity, and
 * profile-filter branches without touching the real plugin installation.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let roots: string[] = [];
let disabledPlugins: string[] = [];
let devModeDirs = new Set<string>();
let hashResults = new Map<string, string>();
let legacyWarnings: number[] = [];
let profileFilter: Set<string> | null = null;
let profileResetCalls = 0;
let infos: string[] = [];
let configLoads = 0;
let warns: string[] = [];

const originalWarn = console.warn;

mock.module(import.meta.resolve("../../src/config"), () => ({
  loadConfig: () => {
    configLoads += 1;
    return { disabledPlugins };
  },
}));

mock.module(import.meta.resolve("../../src/cli/verbosity"), () => ({
  verbose: (fn: () => void) => fn(),
  info: (line: string) => { infos.push(line); },
}));

mock.module(import.meta.resolve("../../src/lib/profile-loader"), () => ({
  resolveActiveProfileFilter: () => profileFilter,
  resetProfileFilterCache: () => { profileResetCalls += 1; },
}));

mock.module(import.meta.resolve("../../src/plugin/registry-helpers"), () => ({
  runtimeSdkVersion: () => "1.0.0",
  scanDirs: () => roots,
  hashFile: (path: string) => hashResults.get(path) ?? "sha256:missing-mock",
  isDevModeInstall: (path: string) => devModeDirs.has(path),
  warnLegacyOnce: (count: number) => { legacyWarnings.push(count); },
  __resetDiscoverStateForTests: () => {},
}));

const { discoverPackages, resetDiscoverCache } = await import("../../src/plugin/registry.ts?plugin-registry-runtime-coverage");

const created: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-registry-runtime-"));
  created.push(dir);
  return dir;
}

function plugin(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(path.split("/").slice(0, -1).join("/") || dir, { recursive: true });
    writeFileSync(path, text);
  }
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name,
    version: "1.0.0",
    sdk: "*",
    target: "js",
    ...manifest,
  }));
  return dir;
}

function entryPlugin(root: string, name: string, manifest: Record<string, unknown> = {}) {
  return plugin(root, name, { entry: "index.js", ...manifest }, { "index.js": "export default {}\n" });
}

function artifactPlugin(root: string, name: string, sha256: string | null, manifest: Record<string, unknown> = {}) {
  return plugin(root, name, {
    artifact: { path: "dist/index.js", sha256 },
    ...manifest,
  }, { "dist/index.js": `export default ${JSON.stringify(name)}\n` });
}

beforeEach(() => {
  roots = [];
  disabledPlugins = [];
  devModeDirs = new Set();
  hashResults = new Map();
  legacyWarnings = [];
  profileFilter = null;
  profileResetCalls = 0;
  infos = [];
  configLoads = 0;
  warns = [];
  console.warn = (line?: unknown) => { warns.push(String(line ?? "")); };
  resetDiscoverCache();
});

afterEach(() => {
  console.warn = originalWarn;
  resetDiscoverCache();
  for (const dir of created.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverPackages registry wiring", () => {
  test("skips missing and unreadable scan roots, memoizes empty results, and resets profile cache", () => {
    const root = tmpRoot();
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "x");
    roots = [join(root, "missing"), fileRoot];

    expect(discoverPackages()).toEqual([]);
    expect(discoverPackages()).toEqual([]);
    expect(configLoads).toBe(1);
    expect(legacyWarnings).toEqual([0]);

    resetDiscoverCache();
    expect(profileResetCalls).toBeGreaterThanOrEqual(2);
    expect(discoverPackages()).toEqual([]);
    expect(configLoads).toBe(2);
  });

  test("applies SDK, artifact, disabled, override, summary, and cache gates", () => {
    const root = tmpRoot();
    roots = [root];
    disabledPlugins = ["disabled-ok"];

    mkdirSync(join(root, "bad-json"));
    writeFileSync(join(root, "bad-json", "plugin.json"), "not json");
    mkdirSync(join(root, "no-plugin"));

    entryPlugin(root, "bad-sdk", { sdk: "^999.0.0" });
    artifactPlugin(root, "unbuilt", null);
    const missing = plugin(root, "missing-artifact", {
      artifact: { path: "dist/missing.js", sha256: "sha256:expected" },
    });
    const mismatch = artifactPlugin(root, "hash-mismatch", "sha256:expected");
    const artifactOk = artifactPlugin(root, "artifact-ok", "sha256:ok", { weight: 80, tier: "standard" });
    const disabledOk = artifactPlugin(root, "disabled-ok", "sha256:disabled", { weight: 70 });
    const legacy = entryPlugin(root, "legacy-ok", { weight: 50 });
    const dev = artifactPlugin(root, "dev-artifact", null, { weight: 60 });

    devModeDirs.add(dev);
    hashResults.set(join(mismatch, "dist/index.js"), "sha256:actual");
    hashResults.set(join(artifactOk, "dist/index.js"), "sha256:ok");
    hashResults.set(join(disabledOk, "dist/index.js"), "sha256:disabled");
    writeFileSync(join(root, ".overrides.json"), JSON.stringify({ "artifact-ok": 5, "disabled-ok": 1 }));

    const first = discoverPackages();
    const second = discoverPackages();

    expect(second).toBe(first);
    expect(first.map((p) => p.manifest.name)).toEqual(["disabled-ok", "artifact-ok", "legacy-ok", "dev-artifact"]);
    expect(first.find((p) => p.manifest.name === "disabled-ok")?.disabled).toBe(true);
    expect(first.find((p) => p.manifest.name === "artifact-ok")?.manifest.weight).toBe(5);
    expect(first.find((p) => p.manifest.name === "disabled-ok")?.manifest.weight).toBe(1);
    expect(first.find((p) => p.manifest.name === "dev-artifact")?.entryPath).toContain("dist/index.js");
    expect(legacyWarnings).toEqual([1]);
    expect(infos).toEqual(["loaded 4 plugins (1 symlink, 2 artifact, 1 legacy)"]);
    expect(warns.join("\n")).toContain("requires maw SDK");
    expect(warns.join("\n")).toContain("plugin 'unbuilt' is unbuilt");
    expect(warns.join("\n")).toContain("plugin 'missing-artifact' artifact missing");
    expect(warns.join("\n")).toContain("plugin 'hash-mismatch' artifact hash mismatch");
    expect(missing).toContain("missing-artifact");
  });

  test("active profile filters discovered plugins after tier defaulting", () => {
    const root = tmpRoot();
    roots = [root];
    const a = artifactPlugin(root, "artifact-ok", "sha256:ok", { tier: "standard" });
    entryPlugin(root, "legacy-ok");
    hashResults.set(join(a, "dist/index.js"), "sha256:ok");
    profileFilter = new Set(["legacy-ok"]);

    const filtered = discoverPackages();

    expect(filtered.map((p) => p.manifest.name)).toEqual(["legacy-ok"]);
    expect(legacyWarnings).toEqual([1]);
  });
});
