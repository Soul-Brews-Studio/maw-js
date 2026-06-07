import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  discoverPackages,
  hashFile,
  resetDiscoverCache,
  type DiscoverPackagesDeps,
} from "../src/plugin/registry.ts?plugin-registry-default";
import type { PluginNameAndTier } from "../src/lib/profile-loader";

let testRoot = "";
let pluginsDir = "";
let mawHome = "";
let originalPluginsDir: string | undefined;
let originalMawHome: string | undefined;
let originalWarnStateFile: string | undefined;
let originalWarn: typeof console.warn;
let warns: string[] = [];

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function writePlugin(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name,
    version: "1.0.0",
    sdk: "*",
    target: "js",
    ...manifest,
  }, null, 2));
  return dir;
}

function writeEntryPlugin(root: string, name: string, manifest: Record<string, unknown> = {}) {
  return writePlugin(root, name, { entry: "index.ts", ...manifest }, {
    "index.ts": `export default async function ${name.replaceAll("-", "_")}() {}\n`,
  });
}

function writeArtifactPlugin(
  root: string,
  name: string,
  artifactText: string,
  sha: string | null,
  manifest: Record<string, unknown> = {},
) {
  const dir = writePlugin(root, name, {
    artifact: { path: "dist/index.js", sha256: sha },
    ...manifest,
  }, {
    "dist/index.js": artifactText,
  });
  return { dir, artifactPath: join(dir, "dist/index.js") };
}

function names() {
  return discoverPackages({
    scanDirs: () => [pluginsDir],
    loadConfig: () => ({ disabledPlugins: [] }),
  }).map((p) => p.manifest.name);
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "maw-plugin-registry-default-"));
  pluginsDir = join(testRoot, "plugins");
  mawHome = join(testRoot, "maw-home");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(mawHome, { recursive: true });

  originalPluginsDir = process.env.MAW_PLUGINS_DIR;
  originalMawHome = process.env.MAW_HOME;
  originalWarnStateFile = process.env.MAW_WARN_STATE_FILE;
  originalWarn = console.warn;
  warns = [];

  process.env.MAW_PLUGINS_DIR = pluginsDir;
  process.env.MAW_HOME = mawHome;
  process.env.MAW_WARN_STATE_FILE = join(testRoot, "warnings.json");
  console.warn = (line?: unknown) => { warns.push(String(line ?? "")); };
  resetDiscoverCache();
});

afterEach(() => {
  resetDiscoverCache();
  console.warn = originalWarn;
  if (originalPluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR;
  else process.env.MAW_PLUGINS_DIR = originalPluginsDir;
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (originalWarnStateFile === undefined) delete process.env.MAW_WARN_STATE_FILE;
  else process.env.MAW_WARN_STATE_FILE = originalWarnStateFile;
  if (testRoot && existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
});

describe("discoverPackages default-suite coverage", () => {
  test("returns an empty list for a missing plugin root", () => {
    expect(discoverPackages({
      scanDirs: () => [join(testRoot, "missing-root")],
      loadConfig: () => ({ disabledPlugins: [] }),
    })).toEqual([]);
  });

  test("memoizes default discovery until resetDiscoverCache is called", () => {
    writeEntryPlugin(pluginsDir, "registry-cache-a");

    const first = discoverPackages({ scanDirs: () => [pluginsDir], useCache: true });
    const second = discoverPackages({ scanDirs: () => [pluginsDir], useCache: true });
    writeEntryPlugin(pluginsDir, "registry-cache-b");
    const cachedAfterMutation = discoverPackages({ scanDirs: () => [pluginsDir], useCache: true });

    expect(second).toBe(first);
    expect(cachedAfterMutation).toBe(first);
    expect(first.map((p) => p.manifest.name)).toEqual(["registry-cache-a"]);

    resetDiscoverCache();
    expect(discoverPackages({ scanDirs: () => [pluginsDir], useCache: true }).map((p) => p.manifest.name).sort()).toEqual([
      "registry-cache-a",
      "registry-cache-b",
    ]);
  });

  test("applies manifest skip, SDK, artifact, dev-mode, disabled, override, and sorting gates", () => {
    mkdirSync(join(pluginsDir, "invalid-json"));
    writeFileSync(join(pluginsDir, "invalid-json", "plugin.json"), "not json");
    mkdirSync(join(pluginsDir, "no-plugin-json"));

    writeEntryPlugin(pluginsDir, "registry-bad-sdk", { sdk: ">=999.0.0" });
    writeArtifactPlugin(pluginsDir, "registry-unbuilt", "export default 'unbuilt';\n", null);
    writePlugin(pluginsDir, "registry-missing-artifact", {
      artifact: { path: "dist/missing.js", sha256: "sha256:expected" },
    });
    writeArtifactPlugin(pluginsDir, "registry-hash-mismatch", "export default 'actual';\n", "sha256:expected");

    const artifactText = "export default 'artifact';\n";
    const disabledText = "export default 'disabled';\n";
    const artifactOk = writeArtifactPlugin(pluginsDir, "registry-artifact-ok", artifactText, sha256(artifactText), {
      weight: 80,
      tier: "standard",
    });
    const disabledOk = writeArtifactPlugin(pluginsDir, "registry-disabled-ok", disabledText, sha256(disabledText), {
      weight: 70,
    });
    writeEntryPlugin(pluginsDir, "registry-legacy-ok", { weight: 50 });

    const devSourceRoot = join(testRoot, "dev-source");
    mkdirSync(devSourceRoot, { recursive: true });
    writeArtifactPlugin(devSourceRoot, "registry-dev-artifact", "export default 'dev';\n", null, { weight: 60 });
    symlinkSync(join(devSourceRoot, "registry-dev-artifact"), join(pluginsDir, "registry-dev-artifact"));

    writeFileSync(join(pluginsDir, ".overrides.json"), JSON.stringify({
      "registry-artifact-ok": 5,
      "registry-disabled-ok": 1,
    }));

    const discovered = discoverPackages({
      scanDirs: () => [pluginsDir],
      loadConfig: () => ({ disabledPlugins: ["registry-disabled-ok"] }),
    });

    expect(discovered.map((p) => p.manifest.name)).toEqual([
      "registry-disabled-ok",
      "registry-artifact-ok",
      "registry-legacy-ok",
      "registry-dev-artifact",
    ]);
    expect(discovered.find((p) => p.manifest.name === "registry-disabled-ok")?.disabled).toBe(true);
    expect(discovered.find((p) => p.manifest.name === "registry-artifact-ok")?.manifest.weight).toBe(5);
    expect(discovered.find((p) => p.manifest.name === "registry-disabled-ok")?.manifest.weight).toBe(1);
    expect(discovered.find((p) => p.manifest.name === "registry-dev-artifact")?.entryPath).toContain("dist/index.js");
    expect(hashFile(artifactOk.artifactPath)).toBe(sha256(artifactText));
    expect(hashFile(disabledOk.artifactPath)).toBe(sha256(disabledText));

    const warningText = warns.join("\n");
    expect(warningText).toContain("requires maw SDK");
    expect(warningText).toContain("plugin 'registry-unbuilt' is unbuilt");
    expect(warningText).toContain("plugin 'registry-missing-artifact' artifact missing");
    expect(warningText).toContain("plugin 'registry-hash-mismatch' artifact hash mismatch");
  });

  test("applies injected active profile filters after defaulting missing tiers to core", () => {
    const artifactText = "export default 'profile artifact';\n";
    writeArtifactPlugin(pluginsDir, "registry-profile-artifact", artifactText, sha256(artifactText), {
      tier: "standard",
      weight: 1,
    });
    writeEntryPlugin(pluginsDir, "registry-profile-legacy", { weight: 2 });
    let seenPlugins: PluginNameAndTier[] = [];
    const deps: DiscoverPackagesDeps = {
      scanDirs: () => [pluginsDir],
      loadConfig: () => ({ disabledPlugins: [] }),
      resolveActiveProfileFilter: (plugins) => {
        seenPlugins = plugins;
        return new Set(["registry-profile-legacy"]);
      },
    };

    const filtered = discoverPackages(deps);

    expect(seenPlugins).toEqual([
      { name: "registry-profile-artifact", tier: "standard" },
      { name: "registry-profile-legacy", tier: "core" },
    ]);
    expect(filtered.map((p) => p.manifest.name)).toEqual(["registry-profile-legacy"]);
  });

  test("no injected profile filter is a passthrough", () => {
    writeEntryPlugin(pluginsDir, "registry-passthrough-a");
    writeEntryPlugin(pluginsDir, "registry-passthrough-b");

    expect(names().sort()).toEqual(["registry-passthrough-a", "registry-passthrough-b"]);
  });
});
