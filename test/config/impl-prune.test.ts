/**
 * Tests for buildPruneCandidates, buildStaleCandidates from
 * src/commands/plugins/oracle/impl-prune.ts.
 * Pure candidate classification — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { buildPruneCandidates, buildStaleCandidates } from "../../src/commands/plugins/oracle/impl-prune";
import type { OracleEntry } from "../../src/core/fleet/registry-oracle-types";
import type { StaleEntry } from "../../src/commands/plugins/oracle/impl-stale";

function makeEntry(name: string, opts: Partial<OracleEntry> = {}): OracleEntry {
  return {
    name, org: "Org", repo: `${name}-oracle`,
    local_path: `/tmp/${name}`, has_psi: false, has_fleet_config: false,
    budded_from: null, budded_at: null, federation_node: null,
    detected_at: "2026-01-01", ...opts,
  };
}

// ─── buildPruneCandidates ───────────────────────────────────────────────────

describe("buildPruneCandidates", () => {
  it("returns empty for no entries", () => {
    expect(buildPruneCandidates([], new Set())).toEqual([]);
  });

  it("marks entry with empty lineage + no tmux + no federation as candidate", () => {
    const entries = [makeEntry("orphan")];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates.length).toBe(1);
    expect(candidates[0].entry.name).toBe("orphan");
    expect(candidates[0].reasons).toContain("empty lineage");
  });

  it("excludes awake oracles", () => {
    const entries = [makeEntry("active")];
    const candidates = buildPruneCandidates(entries, new Set(["active"]));
    expect(candidates.length).toBe(0);
  });

  it("excludes entries with psi", () => {
    const entries = [makeEntry("has-psi", { has_psi: true })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates.length).toBe(0);
  });

  it("excludes entries with fleet config", () => {
    const entries = [makeEntry("fleeted", { has_fleet_config: true })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates.length).toBe(0);
  });

  it("excludes entries with budded_from lineage", () => {
    const entries = [makeEntry("child", { budded_from: "parent" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates.length).toBe(0);
  });

  it("excludes entries with federation_node", () => {
    const entries = [makeEntry("federated", { federation_node: "remote" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates.length).toBe(0);
  });

  it("includes 'not cloned' reason when local_path is empty", () => {
    const entries = [makeEntry("ghost", { local_path: "" })];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates[0].reasons).toContain("not cloned");
  });

  it("handles mixed entries", () => {
    const entries = [
      makeEntry("keep", { has_psi: true }),
      makeEntry("prune1"),
      makeEntry("prune2"),
    ];
    const candidates = buildPruneCandidates(entries, new Set());
    expect(candidates.length).toBe(2);
  });
});

// ─── buildStaleCandidates ───────────────────────────────────────────────────

describe("buildStaleCandidates", () => {
  function makeStale(name: string, tier: string, awake = false): StaleEntry {
    return {
      name, org: "Org", repo: `${name}-oracle`,
      local_path: `/tmp/${name}`, has_psi: false,
      awake, last_commit: "2026-01-01", days_since_commit: 90,
      tier: tier as any, recommendation: "test",
    };
  }

  it("returns empty for empty input", () => {
    expect(buildStaleCandidates([])).toEqual([]);
  });

  it("includes STALE entries", () => {
    const result = buildStaleCandidates([makeStale("old", "STALE")]);
    expect(result.length).toBe(1);
    expect(result[0].tier).toBe("STALE");
  });

  it("includes DEAD entries", () => {
    const result = buildStaleCandidates([makeStale("dead", "DEAD")]);
    expect(result.length).toBe(1);
    expect(result[0].tier).toBe("DEAD");
  });

  it("excludes ACTIVE entries", () => {
    const result = buildStaleCandidates([makeStale("fresh", "ACTIVE")]);
    expect(result.length).toBe(0);
  });

  it("excludes SLOW entries", () => {
    const result = buildStaleCandidates([makeStale("slow", "SLOW")]);
    expect(result.length).toBe(0);
  });

  it("includes 'no tmux' reason when not awake", () => {
    const result = buildStaleCandidates([makeStale("dead", "DEAD", false)]);
    expect(result[0].reasons).toContain("no tmux");
  });

  it("omits 'no tmux' reason when awake", () => {
    const result = buildStaleCandidates([makeStale("dead", "DEAD", true)]);
    expect(result[0].reasons).not.toContain("no tmux");
  });
});
