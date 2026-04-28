/**
 * plugin-loader-profile — Phase 2 of #640 lean-core / closes #890.
 *
 * Tests the wiring between `getActiveProfile()` (#889) and `discoverPackages()`
 * (the hot path every `maw` invocation walks). The shape mirrors
 * profile-loader.test.ts (#888 sibling) — per-test mkdtempSync for
 * MAW_CONFIG_DIR + a fake plugin tree under MAW_HOME so the registry's
 * scanDirs() helper finds our fixtures.
 *
 * Coverage matrix:
 *   - default "all" profile → loads everything (Phase 1 invariant must hold)
 *   - "minimal" profile with `plugins: [...]` → explicit allowlist
 *   - "minimal" profile with `tiers: ["core"]` → tier filter
 *   - profile with BOTH plugins+tiers → union
 *   - missing plugin.json tier → defaults to "core" under tier filter
 *   - missing active-profile pointer → fallback to "all" / no filter
 *   - active profile points at unknown name → fail-open (load all)
 *   - profile cache reuses one resolution per process
 *   - resolution is fast (<5ms) on a realistic plugin set
 *   - resolveActiveProfileFilter null shape on "all" branch
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let mawHome: string;
let pluginsDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;
let originalPluginsDir: string | undefined;

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), "maw-loader-890-"));
  mawHome = mkdtempSync(join(tmpdir(), "maw-home-890-"));
  pluginsDir = join(mawHome, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  originalPluginsDir = process.env.MAW_PLUGINS_DIR;
  // MAW_HOME so the profile loader resolves <MAW_HOME>/config/profile-active
  // and <MAW_HOME>/config/profiles/. MAW_PLUGINS_DIR redirects scanDirs() so
  // the registry only sees our fixtures (not the developer's real ~/.maw).
  process.env.MAW_HOME = mawHome;
  process.env.MAW_PLUGINS_DIR = pluginsDir;
  delete process.env.MAW_CONFIG_DIR;
  // Ensure both caches are clean before each test.
  const { resetProfileFilterCache } = await import("../../src/lib/profile-loader");
  const { resetDiscoverCache } = await import("../../src/plugin/registry");
  resetProfileFilterCache();
  resetDiscoverCache();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalPluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR;
  else process.env.MAW_PLUGINS_DIR = originalPluginsDir;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(mawHome, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

interface Fixture {
  name: string;
  tier?: "core" | "standard" | "extra";
  weight?: number;
}

/** Drop a plugin tree under MAW_PLUGINS_DIR/<name>/ with a minimal manifest
 *  + an entry stub so loadManifestFromDir resolves a valid LoadedPlugin. */
function writePluginTree(plugins: Fixture[]): void {
  for (const p of plugins) {
    const dir = join(pluginsDir, p.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `// fixture entry for ${p.name}\nexport default async function() {}\n`,
      "utf-8",
    );
    const manifest: Record<string, unknown> = {
      name: p.name,
      version: "1.0.0",
      // sdk * = match any runtime version, sidesteps semver gate noise
      sdk: "*",
      entry: "./index.ts",
    };
    if (p.tier) manifest.tier = p.tier;
    if (p.weight !== undefined) manifest.weight = p.weight;
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");
  }
}

function writeProfile(name: string, body: Record<string, unknown>): void {
  const dir = join(mawHome, "config", "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(body, null, 2), "utf-8");
}

function setActive(name: string): void {
  const dir = join(mawHome, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile-active"), name + "\n", "utf-8");
}

async function freshDiscover(): Promise<string[]> {
  const { discoverPackages, resetDiscoverCache } = await import("../../src/plugin/registry");
  const { resetProfileFilterCache } = await import("../../src/lib/profile-loader");
  resetDiscoverCache();
  resetProfileFilterCache();
  return discoverPackages().map((p) => p.manifest.name).sort();
}

// ─── Default behavior: "all" profile loads everything ────────────────────────

describe("active profile = all (default)", () => {
  test("no profile-active pointer → loads everything (passthrough)", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "standard" },
      { name: "gamma", tier: "extra" },
    ]);
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  test("profile-active explicitly = 'all' → loads everything", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "standard" },
    ]);
    setActive("all");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("untiered plugins still load under the default profile", async () => {
    writePluginTree([
      { name: "alpha" },           // no tier field
      { name: "beta", tier: "core" },
    ]);
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

// ─── Profile with explicit `plugins: [...]` allowlist ────────────────────────

describe("profile with explicit plugins[]", () => {
  test("only listed plugins load", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "standard" },
      { name: "gamma", tier: "extra" },
    ]);
    writeProfile("minimal", {
      name: "minimal",
      plugins: ["alpha", "gamma"],
    });
    setActive("minimal");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "gamma"]);
  });

  test("unknown names in plugins[] are silently dropped", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
    ]);
    writeProfile("minimal", {
      name: "minimal",
      plugins: ["alpha", "does-not-exist"],
    });
    setActive("minimal");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha"]);
  });
});

// ─── Profile with `tiers: [...]` filter ──────────────────────────────────────

describe("profile with tiers[] filter", () => {
  test("tiers: ['core'] loads only core-tier plugins", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "standard" },
      { name: "gamma", tier: "extra" },
    ]);
    writeProfile("lean", {
      name: "lean",
      tiers: ["core"],
    });
    setActive("lean");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha"]);
  });

  test("tiers: ['core', 'standard'] loads both", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "standard" },
      { name: "gamma", tier: "extra" },
    ]);
    writeProfile("daily", {
      name: "daily",
      tiers: ["core", "standard"],
    });
    setActive("daily");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("plugin without tier defaults to 'core' under tier filter", async () => {
    writePluginTree([
      { name: "alpha" },                    // missing tier → default core
      { name: "beta", tier: "extra" },
    ]);
    writeProfile("lean", {
      name: "lean",
      tiers: ["core"],
    });
    setActive("lean");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha"]);
  });
});

// ─── Both plugins[] and tiers[] → union ──────────────────────────────────────

describe("profile with both plugins[] and tiers[]", () => {
  test("union of allowlist and tier filter", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },      // matches tiers
      { name: "beta", tier: "extra" },      // matches plugins
      { name: "gamma", tier: "standard" },  // matches neither
    ]);
    writeProfile("custom", {
      name: "custom",
      plugins: ["beta"],
      tiers: ["core"],
    });
    setActive("custom");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

// ─── Pointer edge cases ──────────────────────────────────────────────────────

describe("active profile pointer edge cases", () => {
  test("active profile points at unknown name → fail-open (load all)", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "extra" },
    ]);
    setActive("does-not-exist");
    const names = await freshDiscover();
    // permissive fallback — better than bricking the CLI on a stale pointer
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("empty profile body (no plugins, no tiers) → all", async () => {
    writePluginTree([
      { name: "alpha", tier: "core" },
      { name: "beta", tier: "extra" },
    ]);
    writeProfile("blank", { name: "blank" });
    setActive("blank");
    const names = await freshDiscover();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

// ─── Cache + performance ─────────────────────────────────────────────────────

describe("resolution caching", () => {
  test("resolveActiveProfileFilter is cached per-process", async () => {
    writePluginTree([{ name: "alpha", tier: "core" }]);
    writeProfile("lean", { name: "lean", tiers: ["core"] });
    setActive("lean");

    const { resolveActiveProfileFilter, resetProfileFilterCache } = await import(
      "../../src/lib/profile-loader"
    );
    resetProfileFilterCache();
    const inputs = [{ name: "alpha", tier: "core" as const }];
    const a = resolveActiveProfileFilter(inputs);
    const b = resolveActiveProfileFilter(inputs);
    // Same Set instance returned on cache hit.
    expect(a).toBe(b);
  });

  test("returns null on the 'all' profile (passthrough fast-path)", async () => {
    setActive("all");
    const { resolveActiveProfileFilter, resetProfileFilterCache } = await import(
      "../../src/lib/profile-loader"
    );
    resetProfileFilterCache();
    expect(resolveActiveProfileFilter([{ name: "alpha", tier: "core" }])).toBeNull();
  });

  test("resolution finishes under 5ms on a realistic 50-plugin set", async () => {
    writeProfile("lean", { name: "lean", tiers: ["core"] });
    setActive("lean");
    const inputs = Array.from({ length: 50 }, (_, i) => ({
      name: `plugin-${i}`,
      tier: (i % 3 === 0 ? "core" : i % 3 === 1 ? "standard" : "extra") as
        | "core"
        | "standard"
        | "extra",
    }));
    const { resolveActiveProfileFilter, resetProfileFilterCache } = await import(
      "../../src/lib/profile-loader"
    );
    resetProfileFilterCache();
    const t0 = performance.now();
    resolveActiveProfileFilter(inputs);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5);
  });
});
