/**
 * Tests for src/commands/plugins/oracle/impl-prune.ts — buildPruneCandidates, buildStaleCandidates.
 * Pure classification helpers.
 */
import { describe, it, expect } from "bun:test";
import { buildPruneCandidates, buildStaleCandidates } from "../../src/commands/plugins/oracle/impl-prune";
import type { OracleEntry } from "../../src/core/fleet/registry-oracle-types";
import type { StaleEntry } from "../../src/commands/plugins/oracle/impl-stale";

function makeEntry(overrides: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "org",
    repo: "test-oracle",
    name: "test",
    local_path: "/repos/test",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildPruneCandidates", () => {
  it("marks entry with empty lineage + not awake + no federation as candidate", () => {
    const entries = [makeEntry({ name: "orphan" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].entry.name).toBe("orphan");
  });

  it("excludes awake entries", () => {
    const entries = [makeEntry({ name: "alive" })];
    const candidates = buildPruneCandidates(entries, new Set(["alive"]));
    expect(candidates).toHaveLength(0);
  });

  it("excludes entries with psi", () => {
    const entries = [makeEntry({ name: "haspsi", has_psi: true })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates).toHaveLength(0);
  });

  it("excludes entries with fleet config", () => {
    const entries = [makeEntry({ name: "fleet", has_fleet_config: true })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates).toHaveLength(0);
  });

  it("excludes entries with budded_from", () => {
    const entries = [makeEntry({ name: "budded", budded_from: "parent" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates).toHaveLength(0);
  });

  it("excludes entries with federation_node", () => {
    const entries = [makeEntry({ name: "federated", federation_node: "mba" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates).toHaveLength(0);
  });

  it("includes reasons in candidates", () => {
    const entries = [makeEntry({ name: "orphan", local_path: "" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates[0].reasons).toContain("empty lineage");
    expect(candidates[0].reasons).toContain("not cloned");
    expect(candidates[0].reasons).toContain("no tmux");
    expect(candidates[0].reasons).toContain("no federation");
  });

  it("handles empty entries array", () => {
    expect(buildPruneCandidates([], new Set())).toEqual([]);
  });

  it("filters correctly with mixed entries", () => {
    const entries = [
      makeEntry({ name: "orphan" }),
      makeEntry({ name: "healthy", has_psi: true, has_fleet_config: true }),
      makeEntry({ name: "another-orphan" }),
    ];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates).toHaveLength(2);
    expect(candidates.map(c => c.entry.name)).toEqual(["orphan", "another-orphan"]);
  });
});

describe("buildStaleCandidates", () => {
  function makeStale(overrides: Partial<StaleEntry> = {}): StaleEntry {
    return {
      name: "test",
      org: "org",
      repo: "test-oracle",
      local_path: "/repos/test",
      has_psi: false,
      awake: false,
      last_commit: null,
      days_since_commit: null,
      tier: "DEAD",
      recommendation: "investigate",
      ...overrides,
    };
  }

  it("includes DEAD entries", () => {
    const entries = [makeStale({ name: "dead", tier: "DEAD" })];
    const candidates = buildStaleCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].tier).toBe("DEAD");
  });

  it("includes STALE entries", () => {
    const entries = [makeStale({ name: "stale", tier: "STALE" })];
    const candidates = buildStaleCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].tier).toBe("STALE");
  });

  it("excludes ACTIVE entries", () => {
    const entries = [makeStale({ name: "active", tier: "ACTIVE" })];
    expect(buildStaleCandidates(entries)).toHaveLength(0);
  });

  it("excludes SLOW entries", () => {
    const entries = [makeStale({ name: "slow", tier: "SLOW" })];
    expect(buildStaleCandidates(entries)).toHaveLength(0);
  });

  it("includes reasons with tier label", () => {
    const entries = [makeStale({ tier: "DEAD", recommendation: "prune candidate" })];
    const candidates = buildStaleCandidates(entries);
    expect(candidates[0].reasons).toContain("DEAD (>90d)");
    expect(candidates[0].reasons).toContain("prune candidate");
  });

  it("includes 'no tmux' reason when not awake", () => {
    const entries = [makeStale({ awake: false })];
    const candidates = buildStaleCandidates(entries);
    expect(candidates[0].reasons).toContain("no tmux");
  });

  it("excludes 'no tmux' when awake", () => {
    const entries = [makeStale({ awake: true, tier: "STALE" })];
    const candidates = buildStaleCandidates(entries);
    expect(candidates[0].reasons).not.toContain("no tmux");
  });

  it("preserves entry data in candidate", () => {
    const entries = [makeStale({ name: "spark", org: "myorg", has_psi: true })];
    const candidates = buildStaleCandidates(entries);
    expect(candidates[0].entry.name).toBe("spark");
    expect(candidates[0].entry.org).toBe("myorg");
    expect(candidates[0].entry.has_psi).toBe(true);
  });

  it("handles empty array", () => {
    expect(buildStaleCandidates([])).toEqual([]);
  });
});
