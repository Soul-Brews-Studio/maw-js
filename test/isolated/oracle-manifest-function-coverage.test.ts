import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalCacheDir = process.env.MAW_CACHE_DIR;
const originalStateDir = process.env.MAW_STATE_DIR;
const originalHome = process.env.MAW_HOME;
const originalTestMode = process.env.MAW_TEST_MODE;
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-manifest-function-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
mkdirSync(TEST_FLEET_DIR, { recursive: true });
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_CACHE_DIR = TEST_CONFIG_DIR;
process.env.MAW_STATE_DIR = TEST_CONFIG_DIR;
process.env.MAW_TEST_MODE = "1";
delete process.env.MAW_HOME;

const config = await import("../../src/config");
const manifest = await import("../../src/lib/oracle-manifest.ts?function-coverage");

const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalCacheDir === undefined) delete process.env.MAW_CACHE_DIR;
  else process.env.MAW_CACHE_DIR = originalCacheDir;
  if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalStateDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = originalTestMode;
});

beforeEach(() => {
  rmSync(CONFIG_FILE, { force: true });
  rmSync(ORACLES_JSON, { force: true });
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
  mkdirSync(TEST_FLEET_DIR, { recursive: true });
  config.resetConfig();
  manifest.invalidateManifest();
});

function writeConfig(patch: Record<string, unknown>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(patch), "utf8");
  config.resetConfig();
}

function writeFleet(file: string, body: unknown) {
  writeFileSync(join(TEST_FLEET_DIR, file), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

function writeOraclesJson(oracles: any[]) {
  writeFileSync(ORACLES_JSON, JSON.stringify({ schema: 1, oracles }), "utf8");
}

const oracleEntry = (name: string, patch: Record<string, unknown> = {}) => ({
  org: "Soul-Brews-Studio",
  repo: `${name}-oracle`,
  name,
  local_path: `/tmp/${name}-oracle`,
  has_psi: true,
  has_fleet_config: false,
  budded_from: null,
  budded_at: null,
  federation_node: "white",
  detected_at: "2026-05-18T00:00:00Z",
  ...patch,
});

describe("oracle manifest function coverage", () => {
  test("readFleetWindows tolerates missing, unreadable, and malformed files", () => {
    expect(manifest.readFleetWindows(join(TEST_CONFIG_DIR, "missing"))).toEqual([]);
    const notDir = join(TEST_CONFIG_DIR, "not-dir");
    writeFileSync(notDir, "x", "utf8");
    expect(manifest.readFleetWindows(notDir)).toEqual([]);
    writeFleet("001-good.json", { name: "sess", windows: [{ name: "neo-oracle" }] });
    writeFleet("002-bad.json", "{bad json");
    writeFleet("003-skip.disabled", { name: "skip" });
    expect(manifest.readFleetWindows(TEST_FLEET_DIR)).toEqual([{ name: "sess", windows: [{ name: "neo-oracle" }] }]);
  });

  test("readFleetWindows reads state-first dirs and skips duplicate legacy files", () => {
    const stateFleetDir = join(TEST_CONFIG_DIR, "state-fleet");
    const legacyFleetDir = join(TEST_CONFIG_DIR, "legacy-fleet");
    mkdirSync(stateFleetDir, { recursive: true });
    mkdirSync(legacyFleetDir, { recursive: true });

    writeFileSync(
      join(stateFleetDir, "001-shared.json"),
      JSON.stringify({ name: "state-session", windows: [{ name: "state-oracle" }] }),
      "utf8",
    );
    writeFileSync(
      join(legacyFleetDir, "001-shared.json"),
      "{bad duplicate legacy json",
      "utf8",
    );
    writeFileSync(
      join(legacyFleetDir, "002-legacy.json"),
      JSON.stringify({ name: "legacy-session", windows: [{ name: "legacy-oracle" }] }),
      "utf8",
    );

    expect(manifest.readFleetWindows([stateFleetDir, legacyFleetDir])).toEqual([
      { name: "state-session", windows: [{ name: "state-oracle" }] },
      { name: "legacy-session", windows: [{ name: "legacy-oracle" }] },
    ]);
  });

  test("sync, cached, lookup, and direct oracles-json merge cover precedence branches", () => {
    writeFleet("010-neo.json", { name: "fleet-session", windows: [
      { name: "neo-oracle", repo: "fleet/repo" },
      { name: "not-an-oracle", repo: "ignored/repo" },
      {},
    ] });
    writeConfig({ sessions: { neo: "session-id", empty: "" }, agents: { neo: "m5", "fallback-oracle": "mba" } });
    writeOraclesJson([oracleEntry("neo", { federation_node: "ignored" }), oracleEntry("solo")]);

    const first = manifest.loadManifestCached(30_000);
    expect(manifest.loadManifestCached(30_000)).toBe(first);
    expect(manifest.findOracle("neo")?.node).toBe("m5");
    expect(manifest.findOracle("solo")?.node).toBe("white");
    expect(manifest.loadManifestCached(0)).not.toBe(first);

    const direct = { name: "direct", sources: [], isLive: false } as import("../../src/lib/oracle-manifest").OracleManifestEntry;
    manifest.mergeOraclesJsonEntry(direct, oracleEntry("direct", { org: undefined, repo: undefined, local_path: undefined, federation_node: undefined }) as any);
    expect(direct.sources).toEqual(["oracles-json"]);
    expect(direct.repo).toBeUndefined();
  });

  test("async worktree scan success, skip, throw, cache, and name derivation branches", async () => {
    expect(manifest.oracleNameFromWorktree({ tmuxWindow: "window-oracle", mainRepo: "org/other-oracle" })).toBe("window");
    expect(manifest.oracleNameFromWorktree({ mainRepo: "org/repo-oracle" })).toBe("repo");
    expect(manifest.oracleNameFromWorktree({ tmuxWindow: "plain", mainRepo: "org/plain" })).toBeNull();

    const scan = async () => [
      { path: "/tmp/new-oracle", tmuxWindow: "new-oracle", mainRepo: "org/new-oracle" },
      { path: "/tmp/skip", mainRepo: "org/not-oracle-repo" },
    ];
    const asyncManifest = await manifest.loadManifestAsync(scan);
    expect(asyncManifest.find((e) => e.name === "new")?.sources).toContain("worktree");

    const cached = await manifest.loadManifestCachedAsync(30_000, scan);
    expect(await manifest.loadManifestCachedAsync(30_000, async () => [])).toBe(cached);
    manifest.invalidateManifest();
    await expect(manifest.loadManifestAsync(async () => { throw new Error("scan failed"); })).resolves.toEqual(manifest.loadManifest());
  });
});
