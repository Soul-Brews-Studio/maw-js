import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  activeProfilePath,
  getActiveProfile,
  loadAllProfiles,
  loadProfile,
  profilePath,
  profilesDir,
  resetProfileFilterCache,
  resolveActiveProfileFilter,
  resolveProfilePlugins,
  setActiveProfile,
  validateProfileName,
} from "../../src/lib/profile-loader";

let dir: string;
const originalHome = process.env.MAW_HOME;
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-profile-loader-direct-"));
  delete process.env.MAW_HOME;
  delete process.env.XDG_CONFIG_HOME;
  process.env.MAW_CONFIG_DIR = join(dir, "config");
  resetProfileFilterCache();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("profile-loader direct coverage", () => {
  test("validates names and resolves paths from MAW_CONFIG_DIR or MAW_HOME", () => {
    expect(validateProfileName("daily_core-1")).toBeNull();
    expect(validateProfileName("BadName")).toContain("invalid profile name");
    expect(profilesDir()).toBe(join(dir, "config", "profiles"));
    expect(profilePath("all")).toBe(join(dir, "config", "profiles", "all.json"));
    expect(activeProfilePath()).toBe(join(dir, "config", "profile-active"));

    process.env.MAW_HOME = join(dir, "home");
    delete process.env.MAW_CONFIG_DIR;
    expect(profilesDir()).toBe(join(dir, "home", "config", "profiles"));

    delete process.env.MAW_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "xdg-config");
    expect(profilesDir()).toBe(join(dir, "xdg-config", "maw", "profiles"));
  });

  test("loadProfile seeds all, normalizes missing names, and skips invalid/corrupt profiles", () => {
    expect(loadProfile("BadName")).toBeNull();
    expect(loadProfile("missing")).toBeNull();
    const all = loadProfile("all");
    expect(all?.name).toBe("all");
    expect(existsSync(profilePath("all"))).toBe(true);

    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(profilePath("custom"), JSON.stringify({ plugins: ["alpha"] }), "utf-8");
    expect(loadProfile("custom")?.name).toBe("custom");

    writeFileSync(profilePath("broken"), "{bad-json", "utf-8");
    expect(loadProfile("broken")).toBeNull();
  });

  test("loadAllProfiles sorts valid profiles and ignores corrupt json", () => {
    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(profilePath("zeta"), JSON.stringify({ name: "zeta" }), "utf-8");
    writeFileSync(profilePath("broken"), "{bad-json", "utf-8");

    expect(loadAllProfiles().map((p) => p.name)).toEqual(["all", "zeta"]);
  });

  test("resolveProfilePlugins handles all, explicit plugins, tiers, union, unknowns, and order", () => {
    const plugins = [
      { name: "alpha", tier: "core" as const },
      { name: "beta", tier: "standard" as const },
      { name: "gamma", tier: "extra" as const },
      { name: "untiered" },
    ];
    expect(resolveProfilePlugins({ name: "all" }, plugins)).toEqual(["alpha", "beta", "gamma", "untiered"]);
    expect(resolveProfilePlugins({ name: "explicit", plugins: ["gamma", "missing", "alpha"] }, plugins)).toEqual(["alpha", "gamma"]);
    expect(resolveProfilePlugins({ name: "tiers", tiers: ["standard"] }, plugins)).toEqual(["beta"]);
    expect(resolveProfilePlugins({ name: "union", plugins: ["gamma"], tiers: ["core"] }, plugins)).toEqual(["alpha", "gamma"]);
  });

  test("active profile pointer falls back safely and setActiveProfile writes atomically", () => {
    expect(getActiveProfile()).toBe("all");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(activeProfilePath(), "\n", "utf-8");
    expect(getActiveProfile()).toBe("all");
    writeFileSync(activeProfilePath(), "BadName\n", "utf-8");
    expect(getActiveProfile()).toBe("all");
    rmSync(activeProfilePath(), { force: true });
    mkdirSync(activeProfilePath(), { recursive: true });
    expect(getActiveProfile()).toBe("all");
    rmSync(activeProfilePath(), { recursive: true, force: true });

    expect(() => setActiveProfile("BadName")).toThrow("invalid profile name");
    setActiveProfile("daily");
    expect(readFileSync(activeProfilePath(), "utf-8")).toBe("daily\n");
    expect(getActiveProfile()).toBe("daily");
  });

  test("resolveActiveProfileFilter caches by active profile and plugin fingerprint", () => {
    const plugins = [{ name: "alpha", tier: "core" as const }, { name: "beta", tier: "extra" as const }];
    expect(resolveActiveProfileFilter(plugins)).toBeNull();

    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(profilePath("lean"), JSON.stringify({ name: "lean", tiers: ["core"] }), "utf-8");
    setActiveProfile("lean");
    const first = resolveActiveProfileFilter(plugins);
    const second = resolveActiveProfileFilter(plugins);
    expect(first).toBe(second);
    expect([...first!]).toEqual(["alpha"]);

    const changed = resolveActiveProfileFilter([...plugins, { name: "gamma", tier: "core" as const }]);
    expect(changed).not.toBe(first);
    expect([...changed!]).toEqual(["alpha", "gamma"]);

    setActiveProfile("missing");
    expect(resolveActiveProfileFilter(plugins)).toBeNull();

    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(profilePath("empty"), JSON.stringify({ name: "empty" }), "utf-8");
    setActiveProfile("empty");
    expect(resolveActiveProfileFilter(plugins)).toBeNull();

    writeFileSync(profilePath("corrupt"), "{bad-json", "utf-8");
    setActiveProfile("corrupt");
    expect(resolveActiveProfileFilter(plugins)).toBeNull();
  });
});
