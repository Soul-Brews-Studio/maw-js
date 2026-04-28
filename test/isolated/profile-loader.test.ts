/**
 * profile-loader — unit tests (#888 / Phase 1 of #640 lean-core).
 *
 * Covers `src/lib/profile-loader.ts` plus the impl layer of the
 * `maw profile` plugin. Verbs under test:
 *   - loadProfile / loadAllProfiles
 *   - getActiveProfile / setActiveProfile (round-trip)
 *   - resolveProfilePlugins (plugins-only, tiers-only, union, neither)
 *   - default "all" auto-seed on first read
 *   - validateProfileName
 *
 * Isolation: we redirect MAW_CONFIG_DIR to a per-test mkdtempSync dir BEFORE
 * any dynamic import. The loader resolves paths at call-time (not import-time)
 * so a fresh env per beforeEach is enough. Mirrors scope-primitive.test.ts
 * (#642 Phase 1) which uses the same scaffold.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-profile-888-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = testDir;
  delete process.env.MAW_HOME;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function writeProfile(name: string, body: Record<string, unknown>): void {
  const dir = join(testDir, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify(body, null, 2) + "\n",
    "utf-8",
  );
}

// Re-import the loader on every test so MAW_CONFIG_DIR mutations land. The
// loader itself doesn't cache, but bun:test caches modules across tests in a
// file → we still want a fresh import in case future refactors add module
// state.
async function importLoader() {
  return await import("../../src/lib/profile-loader");
}

// ─── Validation ──────────────────────────────────────────────────────────────

describe("validateProfileName", () => {
  test("accepts slug-safe names", async () => {
    const { validateProfileName } = await importLoader();
    expect(validateProfileName("minimal")).toBeNull();
    expect(validateProfileName("a")).toBeNull();
    expect(validateProfileName("dev_2")).toBeNull();
    expect(validateProfileName("federation-set")).toBeNull();
  });

  test("rejects empty / leading-hyphen / uppercase / overlong", async () => {
    const { validateProfileName } = await importLoader();
    expect(validateProfileName("")).not.toBeNull();
    expect(validateProfileName("-bad")).not.toBeNull();
    expect(validateProfileName("BAD")).not.toBeNull();
    expect(validateProfileName("a".repeat(65))).not.toBeNull();
  });
});

// ─── loadProfile ─────────────────────────────────────────────────────────────

describe("loadProfile", () => {
  test("returns null for missing file (non-default name)", async () => {
    const { loadProfile } = await importLoader();
    expect(loadProfile("does-not-exist")).toBeNull();
  });

  test("returns null for invalid name", async () => {
    const { loadProfile } = await importLoader();
    expect(loadProfile("BAD!")).toBeNull();
  });

  test("loads a hand-written profile by name", async () => {
    writeProfile("dev", {
      name: "dev",
      plugins: ["scope", "ls"],
      tiers: ["core"],
      description: "developer profile",
    });
    const { loadProfile } = await importLoader();
    const p = loadProfile("dev");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("dev");
    expect(p?.plugins).toEqual(["scope", "ls"]);
    expect(p?.tiers).toEqual(["core"]);
    expect(p?.description).toBe("developer profile");
  });

  test("auto-seeds the default 'all' profile on first load", async () => {
    const { loadProfile, profilePath } = await importLoader();
    const path = profilePath("all");
    expect(existsSync(path)).toBe(false);
    const all = loadProfile("all");
    expect(all).not.toBeNull();
    expect(all?.name).toBe("all");
    expect(all?.plugins).toBeUndefined();
    expect(all?.tiers).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });

  test("does not overwrite an existing 'all' profile", async () => {
    writeProfile("all", {
      name: "all",
      plugins: ["custom"],
      description: "operator-edited",
    });
    const { loadProfile } = await importLoader();
    const all = loadProfile("all");
    expect(all?.plugins).toEqual(["custom"]);
    expect(all?.description).toBe("operator-edited");
  });

  test("tolerates malformed JSON (returns null, no crash)", async () => {
    const dir = join(testDir, "profiles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    const { loadProfile } = await importLoader();
    expect(loadProfile("broken")).toBeNull();
  });
});

// ─── loadAllProfiles ─────────────────────────────────────────────────────────

describe("loadAllProfiles", () => {
  test("returns just the auto-seeded 'all' on a fresh CONFIG_DIR", async () => {
    const { loadAllProfiles } = await importLoader();
    const all = loadAllProfiles();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe("all");
  });

  test("includes hand-written profiles, sorted by name", async () => {
    writeProfile("zeta", { name: "zeta" });
    writeProfile("alpha", { name: "alpha", plugins: ["scope"] });
    const { loadAllProfiles } = await importLoader();
    const names = loadAllProfiles().map((p) => p.name);
    expect(names).toEqual(["all", "alpha", "zeta"]);
  });

  test("skips a single corrupt file without poisoning the list", async () => {
    writeProfile("good", { name: "good" });
    const dir = join(testDir, "profiles");
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    const { loadAllProfiles } = await importLoader();
    const names = loadAllProfiles().map((p) => p.name);
    expect(names).toContain("good");
    expect(names).toContain("all");
    expect(names).not.toContain("broken");
  });
});

// ─── Active profile pointer ──────────────────────────────────────────────────

describe("getActiveProfile / setActiveProfile", () => {
  test("defaults to 'all' when no pointer file exists", async () => {
    const { getActiveProfile } = await importLoader();
    expect(getActiveProfile()).toBe("all");
  });

  test("setActiveProfile then getActiveProfile round-trips", async () => {
    const { setActiveProfile, getActiveProfile, activeProfilePath } =
      await importLoader();
    setActiveProfile("minimal");
    expect(getActiveProfile()).toBe("minimal");
    // pointer file is plain text, not JSON.
    expect(readFileSync(activeProfilePath(), "utf-8").trim()).toBe("minimal");
  });

  test("setActiveProfile rejects invalid names", async () => {
    const { setActiveProfile } = await importLoader();
    expect(() => setActiveProfile("BAD!")).toThrow(/invalid profile name/);
  });

  test("getActiveProfile falls back to 'all' on garbage pointer content", async () => {
    const { getActiveProfile, activeProfilePath } = await importLoader();
    mkdirSync(testDir, { recursive: true });
    writeFileSync(activeProfilePath(), "BAD!\n", "utf-8");
    expect(getActiveProfile()).toBe("all");
  });

  test("getActiveProfile falls back to 'all' on empty pointer file", async () => {
    const { getActiveProfile, activeProfilePath } = await importLoader();
    writeFileSync(activeProfilePath(), "", "utf-8");
    expect(getActiveProfile()).toBe("all");
  });
});

// ─── resolveProfilePlugins ───────────────────────────────────────────────────

describe("resolveProfilePlugins", () => {
  const plugins = [
    { name: "scope",   tier: "core" as const },
    { name: "trust",   tier: "core" as const },
    { name: "inbox",   tier: "core" as const },
    { name: "ls",      tier: "core" as const },
    { name: "send",    tier: "standard" as const },
    { name: "wake",    tier: "standard" as const },
    { name: "bud",     tier: "extra" as const },
    { name: "untiered" }, // intentionally tier-less
  ];

  test("empty profile (no plugins/tiers) → all plugins", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins({ name: "all" }, plugins);
    expect(got).toEqual(plugins.map((p) => p.name));
  });

  test("explicit `plugins` allowlist", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins(
      { name: "minimal", plugins: ["scope", "inbox", "ls"] },
      plugins,
    );
    expect(got).toEqual(["scope", "inbox", "ls"]);
  });

  test("explicit `plugins` drops unknown entries silently", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins(
      { name: "typo", plugins: ["scope", "ghost", "xxx"] },
      plugins,
    );
    expect(got).toEqual(["scope"]);
  });

  test("`tiers` filter — core only", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins(
      { name: "lean", tiers: ["core"] },
      plugins,
    );
    expect(got).toEqual(["scope", "trust", "inbox", "ls"]);
  });

  test("`tiers` filter — multiple tiers", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins(
      { name: "dev", tiers: ["core", "standard"] },
      plugins,
    );
    expect(got).toEqual(["scope", "trust", "inbox", "ls", "send", "wake"]);
  });

  test("`tiers` filter excludes plugins without a tier field", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins(
      { name: "lean", tiers: ["core"] },
      plugins,
    );
    expect(got).not.toContain("untiered");
  });

  test("union: `plugins` ∪ `tiers` — both contribute, no duplicates", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const got = resolveProfilePlugins(
      {
        name: "hybrid",
        plugins: ["bud", "scope"], // scope is also in core tier
        tiers: ["core"],
      },
      plugins,
    );
    // expected: union of {bud, scope} ∪ {scope, trust, inbox, ls},
    // returned in input order → scope, trust, inbox, ls, bud
    expect(got).toEqual(["scope", "trust", "inbox", "ls", "bud"]);
    // dedup check
    expect(new Set(got).size).toBe(got.length);
  });

  test("preserves input order (caller-side weight ordering survives)", async () => {
    const { resolveProfilePlugins } = await importLoader();
    const reordered = [
      { name: "wake", tier: "standard" as const },
      { name: "scope", tier: "core" as const },
      { name: "send", tier: "standard" as const },
    ];
    const got = resolveProfilePlugins(
      { name: "set", tiers: ["core", "standard"] },
      reordered,
    );
    expect(got).toEqual(["wake", "scope", "send"]);
  });
});

// ─── KNOWN_PROFILE_SEEDS sanity ──────────────────────────────────────────────

describe("KNOWN_PROFILE_SEEDS", () => {
  test("includes 'all' (no filters) and 'minimal' (with plugins+tiers)", async () => {
    const { KNOWN_PROFILE_SEEDS } = await importLoader();
    const all = KNOWN_PROFILE_SEEDS.find((p) => p.name === "all");
    const minimal = KNOWN_PROFILE_SEEDS.find((p) => p.name === "minimal");
    expect(all).toBeTruthy();
    expect(all?.plugins).toBeUndefined();
    expect(all?.tiers).toBeUndefined();
    expect(minimal).toBeTruthy();
    expect(Array.isArray(minimal?.plugins)).toBe(true);
    expect(Array.isArray(minimal?.tiers)).toBe(true);
  });
});

// ─── Integration with the impl layer (cmd*) ─────────────────────────────────

describe("profile plugin impl", () => {
  test("cmdCurrent returns 'all' before any setActiveProfile", async () => {
    const impl = await import("../../src/commands/plugins/profile/impl");
    expect(impl.cmdCurrent()).toBe("all");
  });

  test("cmdUse switches the active profile when the file exists", async () => {
    writeProfile("minimal", {
      name: "minimal",
      plugins: ["scope", "ls"],
      tiers: ["core"],
    });
    const impl = await import("../../src/commands/plugins/profile/impl");
    impl.cmdUse("minimal");
    expect(impl.cmdCurrent()).toBe("minimal");
  });

  test("cmdUse refuses unknown profile name", async () => {
    const impl = await import("../../src/commands/plugins/profile/impl");
    expect(() => impl.cmdUse("ghost")).toThrow(/not found/);
  });

  test("cmdShow returns null for unknown name; full object for known", async () => {
    writeProfile("dev", { name: "dev", plugins: ["scope"] });
    const impl = await import("../../src/commands/plugins/profile/impl");
    expect(impl.cmdShow("ghost")).toBeNull();
    const found = impl.cmdShow("dev");
    expect(found?.name).toBe("dev");
    expect(found?.plugins).toEqual(["scope"]);
  });

  test("cmdList includes the auto-seeded 'all' even with zero hand-written profiles", async () => {
    const impl = await import("../../src/commands/plugins/profile/impl");
    const rows = impl.cmdList();
    expect(rows.find((r) => r.name === "all")).toBeTruthy();
  });

  test("formatList marks the active profile with *", async () => {
    writeProfile("dev", { name: "dev", plugins: ["scope"] });
    const impl = await import("../../src/commands/plugins/profile/impl");
    impl.cmdUse("dev");
    const rendered = impl.formatList(impl.cmdList(), impl.cmdCurrent());
    const devLine = rendered.split("\n").find((l) => l.includes("dev"));
    expect(devLine).toBeTruthy();
    expect(devLine!.startsWith("*")).toBe(true);
  });
});
