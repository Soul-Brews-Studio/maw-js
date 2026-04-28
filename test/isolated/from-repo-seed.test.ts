/**
 * Tests for parentMemoryPath, seedFromParent, copyPeersSnapshot
 * from src/commands/plugins/bud/from-repo-seed.ts.
 * Uses mock.module to stub loadConfig and peersPath.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let mockConfig = { ghqRoot: "/tmp/ghq", githubOrg: "TestOrg" };
let mockPeersJsonPath = "/tmp/no-peers.json";

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => mockConfig,
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

mock.module("../../src/commands/plugins/peers/store", () => ({
  peersPath: () => mockPeersJsonPath,
}));

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp/maw-test",
  resolveHome: () => "/tmp/maw-test",
}));

const { parentMemoryPath, seedFromParent, copyPeersSnapshot } = await import(
  "../../src/commands/plugins/bud/from-repo-seed"
);

describe("parentMemoryPath", () => {
  it("resolves to ghqRoot/org/stem-oracle/ψ/memory", () => {
    const result = parentMemoryPath("pulse");
    expect(result).toBe("/tmp/ghq/TestOrg/pulse-oracle/ψ/memory");
  });

  it("uses default org when githubOrg not set", () => {
    const origOrg = mockConfig.githubOrg;
    mockConfig.githubOrg = undefined as any;
    const result = parentMemoryPath("neo");
    expect(result).toContain("Soul-Brews-Studio/neo-oracle");
    mockConfig.githubOrg = origOrg;
  });
});

describe("seedFromParent", () => {
  it("skips when parent memory path does not exist", () => {
    const logs: string[] = [];
    seedFromParent("/tmp/target-doesnt-matter", "nonexistent-parent", (m: string) => logs.push(m));
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("skip");
  });

  it("copies parent memory to target when source exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seed-test-"));
    const ghqRoot = join(tmp, "ghq");
    const parentDir = join(ghqRoot, "TestOrg", "boom-oracle", "ψ", "memory");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "test.md"), "hello from parent");

    const target = join(tmp, "target-repo");
    mkdirSync(join(target, "ψ", "memory"), { recursive: true });

    mockConfig.ghqRoot = ghqRoot;
    const logs: string[] = [];
    seedFromParent(target, "boom", (m: string) => logs.push(m));
    mockConfig.ghqRoot = "/tmp/ghq"; // restore

    expect(existsSync(join(target, "ψ", "memory", "test.md"))).toBe(true);
    expect(logs.some((l: string) => l.includes("✓"))).toBe(true);
  });
});

describe("copyPeersSnapshot", () => {
  it("skips when peers.json does not exist", () => {
    mockPeersJsonPath = "/tmp/nonexistent-peers.json";
    const logs: string[] = [];
    copyPeersSnapshot("/tmp/target", (m: string) => logs.push(m));
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("skip");
  });

  it("copies peers.json to target/ψ/peers.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "peers-snap-"));
    const peersFile = join(tmp, "peers.json");
    writeFileSync(peersFile, JSON.stringify({ peers: ["http://localhost:3456"] }));
    mockPeersJsonPath = peersFile;

    const target = join(tmp, "target-repo");
    mkdirSync(target, { recursive: true });

    const logs: string[] = [];
    copyPeersSnapshot(target, (m: string) => logs.push(m));

    expect(existsSync(join(target, "ψ", "peers.json"))).toBe(true);
    expect(logs.some((l: string) => l.includes("✓"))).toBe(true);
  });
});
