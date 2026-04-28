/**
 * Tests for scanAndCache and scanFull from
 * src/core/fleet/registry-oracle-orchestrate.ts.
 * Mocks all dependencies: config, scanLocal, scanRemote, writeCache.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OracleEntry, RegistryCache } from "../../src/core/fleet/registry-oracle-types";

const tmp = mkdtempSync(join(tmpdir(), "reg-orch-"));

let localEntries: OracleEntry[] = [];
let remoteEntries: OracleEntry[] = [];
const writtenCaches: RegistryCache[] = [];

function makeEntry(org: string, repo: string, overrides: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org,
    repo,
    name: repo.replace(/-oracle$/, ""),
    local_path: join(tmp, org, repo),
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({
    ghqRoot: join(tmp, "ghq"),
    node: "test",
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: (n: string, d: string) => `echo ${n}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

const _rScanLocal = await import("../../src/core/fleet/registry-oracle-scan-local");

mock.module("../../src/core/fleet/registry-oracle-scan-local", () => ({
  ..._rScanLocal,
  scanLocal: () => localEntries,
}));

mock.module("../../src/core/fleet/registry-oracle-scan-remote", () => ({
  scanRemote: async () => remoteEntries,
}));

mock.module("../../src/core/fleet/registry-oracle-cache", () => ({
  readCache: () => ({ schema: 1, local_scanned_at: "", ghq_root: "", oracles: [] }),
  writeCache: (cache: RegistryCache) => { writtenCaches.push(JSON.parse(JSON.stringify(cache))); },
  isCacheStale: () => true,
  mergeRegistry: (a: OracleEntry[], b: OracleEntry[]) => [...a, ...b],
}));

const { scanAndCache, scanFull } = await import(
  "../../src/core/fleet/registry-oracle-orchestrate"
);

beforeEach(() => {
  localEntries = [];
  remoteEntries = [];
  writtenCaches.length = 0;
});

// ─── scanAndCache ─────────────────────────────────────────────────────────────

describe("scanAndCache", () => {
  it("returns cache with schema 1", () => {
    const result = scanAndCache("local", false);
    expect(result.schema).toBe(1);
  });

  it("includes ghqRoot from config", () => {
    const result = scanAndCache("local", false);
    expect(result.ghq_root).toBe(join(tmp, "ghq"));
  });

  it("includes local_scanned_at timestamp", () => {
    const before = new Date().toISOString();
    const result = scanAndCache("local", false);
    expect(result.local_scanned_at).toBeDefined();
    expect(result.local_scanned_at >= before).toBe(true);
  });

  it("includes local entries in cache", () => {
    localEntries = [makeEntry("org", "neo-oracle"), makeEntry("org", "pulse-oracle")];
    const result = scanAndCache("local", false);
    expect(result.oracles).toHaveLength(2);
  });

  it("writes cache to disk", () => {
    localEntries = [makeEntry("org", "neo-oracle")];
    scanAndCache("local", false);
    expect(writtenCaches).toHaveLength(1);
    expect(writtenCaches[0].oracles).toHaveLength(1);
  });

  it("returns empty oracles when no local entries found", () => {
    const result = scanAndCache("local", false);
    expect(result.oracles).toEqual([]);
  });

  it("skips local scan in remote mode", () => {
    localEntries = [makeEntry("org", "should-not-appear")];
    const result = scanAndCache("remote", false);
    expect(result.oracles).toEqual([]);
  });

  it("includes local entries in both mode", () => {
    localEntries = [makeEntry("org", "neo-oracle")];
    const result = scanAndCache("both", false);
    expect(result.oracles).toHaveLength(1);
  });

  it("defaults to local mode", () => {
    localEntries = [makeEntry("org", "neo-oracle")];
    const result = scanAndCache();
    expect(result.oracles).toHaveLength(1);
  });
});

// ─── scanFull ─────────────────────────────────────────────────────────────────

describe("scanFull", () => {
  it("merges local and remote entries", async () => {
    localEntries = [makeEntry("org", "neo-oracle")];
    remoteEntries = [makeEntry("org", "pulse-oracle")];
    const result = await scanFull(undefined, false);
    expect(result.oracles).toHaveLength(2);
  });

  it("local entries take priority over remote", async () => {
    localEntries = [makeEntry("org", "neo-oracle", { has_psi: true })];
    remoteEntries = [makeEntry("org", "neo-oracle", { has_psi: false })];
    const result = await scanFull(undefined, false);
    expect(result.oracles).toHaveLength(1);
    expect(result.oracles[0].has_psi).toBe(true);
  });

  it("enriches local with remote psi status", async () => {
    localEntries = [makeEntry("org", "neo-oracle", { has_psi: false })];
    remoteEntries = [makeEntry("org", "neo-oracle", { has_psi: true })];
    const result = await scanFull(undefined, false);
    expect(result.oracles[0].has_psi).toBe(true);
  });

  it("does not enrich when remote also lacks psi", async () => {
    localEntries = [makeEntry("org", "neo-oracle", { has_psi: false })];
    remoteEntries = [makeEntry("org", "neo-oracle", { has_psi: false })];
    const result = await scanFull(undefined, false);
    expect(result.oracles[0].has_psi).toBe(false);
  });

  it("sorts results by org then name", async () => {
    localEntries = [
      makeEntry("z-org", "alpha-oracle"),
      makeEntry("a-org", "zeta-oracle"),
      makeEntry("a-org", "alpha-oracle"),
    ];
    const result = await scanFull(undefined, false);
    const names = result.oracles.map(o => `${o.org}/${o.name}`);
    expect(names).toEqual(["a-org/alpha", "a-org/zeta", "z-org/alpha"]);
  });

  it("writes cache to disk", async () => {
    localEntries = [makeEntry("org", "neo-oracle")];
    await scanFull(undefined, false);
    expect(writtenCaches).toHaveLength(1);
  });

  it("returns empty when no entries from either source", async () => {
    const result = await scanFull(undefined, false);
    expect(result.oracles).toEqual([]);
  });

  it("adds remote-only entries that are not local", async () => {
    remoteEntries = [makeEntry("remote-org", "remote-oracle")];
    const result = await scanFull(undefined, false);
    expect(result.oracles).toHaveLength(1);
    expect(result.oracles[0].org).toBe("remote-org");
  });
});
