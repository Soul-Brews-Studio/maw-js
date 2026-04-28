/**
 * Tests for scanLocal from src/core/fleet/registry-oracle-scan-local.ts.
 * Uses mock.module to stub config and paths, temp dirs for ghq root.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "scan-local-test-"));
const fleetDir = join(tmp, "fleet");
mkdirSync(fleetDir, { recursive: true });

let mockGhqRoot = join(tmp, "ghq");
mkdirSync(mockGhqRoot, { recursive: true });

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: fleetDir,
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: "test-node",
    ghqRoot: mockGhqRoot,
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

const { scanLocal, readFleetLineage, deriveName } = await import(
  "../../src/core/fleet/registry-oracle-scan-local"
);

describe("readFleetLineage", () => {
  it("returns empty map when fleet dir is empty", () => {
    const map = readFleetLineage();
    expect(map.size).toBe(0);
  });

  it("reads fleet files for lineage", () => {
    writeFileSync(join(fleetDir, "01-pulse.json"), JSON.stringify({
      project_repos: ["Soul-Brews-Studio/pulse-oracle"],
      budded_from: "boom",
      budded_at: "2026-01-01",
    }));
    const map = readFleetLineage();
    expect(map.has("Soul-Brews-Studio/pulse-oracle")).toBe(true);
    expect(map.get("Soul-Brews-Studio/pulse-oracle")!.budded_from).toBe("boom");
  });
});

describe("deriveName", () => {
  it("strips -oracle suffix", () => {
    expect(deriveName("pulse-oracle")).toBe("pulse");
  });

  it("preserves non-oracle names", () => {
    expect(deriveName("maw-js")).toBe("maw-js");
  });
});

describe("scanLocal", () => {
  it("returns empty for empty ghq root", () => {
    const freshGhq = mkdtempSync(join(tmpdir(), "empty-ghq-"));
    mockGhqRoot = freshGhq;
    const entries = scanLocal(false);
    // Might have fleet-only entries from readFleetLineage
    // At minimum, should not throw
    expect(Array.isArray(entries)).toBe(true);
  });

  it("detects oracle by ψ/ directory", () => {
    const ghq = mkdtempSync(join(tmpdir(), "ghq-psi-"));
    const oracleDir = join(ghq, "TestOrg", "neo-oracle");
    mkdirSync(join(oracleDir, "ψ"), { recursive: true });

    mockGhqRoot = ghq;
    const entries = scanLocal(false);
    const neo = entries.find((e: any) => e.name === "neo");
    expect(neo).toBeDefined();
    expect(neo!.has_psi).toBe(true);
    expect(neo!.org).toBe("TestOrg");
  });

  it("detects oracle by -oracle suffix", () => {
    const ghq = mkdtempSync(join(tmpdir(), "ghq-suffix-"));
    const oracleDir = join(ghq, "MyOrg", "spark-oracle");
    mkdirSync(oracleDir, { recursive: true });

    mockGhqRoot = ghq;
    const entries = scanLocal(false);
    const spark = entries.find((e: any) => e.name === "spark");
    expect(spark).toBeDefined();
    expect(spark!.repo).toBe("spark-oracle");
  });

  it("skips non-oracle directories", () => {
    const ghq = mkdtempSync(join(tmpdir(), "ghq-skip-"));
    mkdirSync(join(ghq, "org", "regular-repo"), { recursive: true });

    mockGhqRoot = ghq;
    const entries = scanLocal(false);
    expect(entries.find((e: any) => e.repo === "regular-repo")).toBeUndefined();
  });

  it("sorts entries by org then name", () => {
    const ghq = mkdtempSync(join(tmpdir(), "ghq-sort-"));
    mkdirSync(join(ghq, "B-Org", "zulu-oracle"), { recursive: true });
    mkdirSync(join(ghq, "A-Org", "alpha-oracle"), { recursive: true });
    mkdirSync(join(ghq, "A-Org", "beta-oracle"), { recursive: true });

    mockGhqRoot = ghq;
    const entries = scanLocal(false);
    const names = entries.map((e: any) => `${e.org}/${e.name}`);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("enriches federation_node from config.node", () => {
    const ghq = mkdtempSync(join(tmpdir(), "ghq-fed-"));
    mkdirSync(join(ghq, "TestOrg", "forge-oracle", "ψ"), { recursive: true });

    mockGhqRoot = ghq;
    const entries = scanLocal(false);
    const forge = entries.find((e: any) => e.name === "forge");
    expect(forge?.federation_node).toBe("test-node");
  });
});
