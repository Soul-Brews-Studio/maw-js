/**
 * Tests for src/commands/plugins/oracle/impl-stale.ts — classifyStaleness, sortByStaleness.
 * Pure classification and sorting logic.
 */
import { describe, it, expect } from "bun:test";
import { classifyStaleness, sortByStaleness, type StaleEntry } from "../../src/commands/plugins/oracle/impl-stale";

const NOW = new Date("2026-04-27T12:00:00Z");

function makeEntry(overrides: Partial<{ name: string; org: string; repo: string; local_path: string; has_psi: boolean }> = {}) {
  return {
    name: overrides.name ?? "test",
    org: overrides.org ?? "org",
    repo: overrides.repo ?? "test-oracle",
    local_path: overrides.local_path ?? "/repos/test-oracle",
    has_psi: overrides.has_psi ?? false,
  };
}

describe("classifyStaleness", () => {
  it("classifies awake oracle as ACTIVE regardless of commit date", () => {
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: "2025-01-01T00:00:00Z", // very old
      awake: true,
      now: NOW,
    });
    expect(result.tier).toBe("ACTIVE");
    expect(result.recommendation).toBe("awake in tmux");
  });

  it("classifies null commit with no local_path as DEAD", () => {
    const result = classifyStaleness({
      entry: makeEntry({ local_path: "" }),
      lastCommitISO: null,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("DEAD");
    expect(result.recommendation).toContain("not cloned");
  });

  it("classifies null commit with local_path as DEAD", () => {
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: null,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("DEAD");
    expect(result.recommendation).toContain("no commits");
  });

  it("classifies recent commit (<7d) as ACTIVE", () => {
    const recent = new Date(NOW.getTime() - 3 * 86_400_000).toISOString(); // 3 days ago
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: recent,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("ACTIVE");
    expect(result.recommendation).toBe("recent activity");
    expect(result.days_since_commit).toBe(3);
  });

  it("classifies 7-30d commit as SLOW", () => {
    const slow = new Date(NOW.getTime() - 15 * 86_400_000).toISOString(); // 15 days ago
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: slow,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("SLOW");
    expect(result.recommendation).toBe("monitor");
  });

  it("classifies 30-90d commit as STALE", () => {
    const stale = new Date(NOW.getTime() - 60 * 86_400_000).toISOString(); // 60 days ago
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: stale,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("STALE");
    expect(result.recommendation).toBe("investigate");
  });

  it("classifies >90d commit without psi as prune candidate", () => {
    const dead = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
    const result = classifyStaleness({
      entry: makeEntry({ has_psi: false }),
      lastCommitISO: dead,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("DEAD");
    expect(result.recommendation).toContain("prune");
  });

  it("classifies >90d commit with psi as archive", () => {
    const dead = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
    const result = classifyStaleness({
      entry: makeEntry({ has_psi: true }),
      lastCommitISO: dead,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("DEAD");
    expect(result.recommendation).toContain("archive");
  });

  it("boundary: exactly 7 days → SLOW (not ACTIVE)", () => {
    const boundary = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: boundary,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("SLOW");
  });

  it("boundary: exactly 30 days → STALE (not SLOW)", () => {
    const boundary = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: boundary,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("STALE");
  });

  it("boundary: exactly 90 days → DEAD (not STALE)", () => {
    const boundary = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const result = classifyStaleness({
      entry: makeEntry(),
      lastCommitISO: boundary,
      awake: false,
      now: NOW,
    });
    expect(result.tier).toBe("DEAD");
  });

  it("preserves entry fields in output", () => {
    const result = classifyStaleness({
      entry: makeEntry({ name: "spark", org: "myorg", repo: "spark-oracle", has_psi: true }),
      lastCommitISO: "2026-04-25T00:00:00Z",
      awake: false,
      now: NOW,
    });
    expect(result.name).toBe("spark");
    expect(result.org).toBe("myorg");
    expect(result.repo).toBe("spark-oracle");
    expect(result.has_psi).toBe(true);
    expect(result.awake).toBe(false);
  });
});

describe("sortByStaleness", () => {
  function makeStale(tier: string, days: number | null, name: string): StaleEntry {
    return {
      name,
      org: "org",
      repo: `${name}-oracle`,
      local_path: `/repos/${name}`,
      has_psi: false,
      awake: false,
      last_commit: days !== null ? "2026-01-01" : null,
      days_since_commit: days,
      tier: tier as any,
      recommendation: "",
    };
  }

  it("sorts DEAD before STALE before SLOW before ACTIVE", () => {
    const entries = [
      makeStale("ACTIVE", 1, "a"),
      makeStale("DEAD", 100, "b"),
      makeStale("SLOW", 15, "c"),
      makeStale("STALE", 50, "d"),
    ];
    const sorted = sortByStaleness(entries);
    expect(sorted.map(e => e.tier)).toEqual(["DEAD", "STALE", "SLOW", "ACTIVE"]);
  });

  it("within same tier, sorts by days_since_commit descending (oldest first)", () => {
    const entries = [
      makeStale("STALE", 40, "young"),
      makeStale("STALE", 80, "old"),
      makeStale("STALE", 60, "mid"),
    ];
    const sorted = sortByStaleness(entries);
    expect(sorted.map(e => e.name)).toEqual(["old", "mid", "young"]);
  });

  it("null days_since_commit sorts as oldest (Infinity)", () => {
    const entries = [
      makeStale("DEAD", 100, "with-date"),
      makeStale("DEAD", null, "no-date"),
    ];
    const sorted = sortByStaleness(entries);
    expect(sorted[0].name).toBe("no-date"); // null → Infinity → sorted first (oldest)
  });

  it("same tier + same days → sorts alphabetically by name", () => {
    const entries = [
      makeStale("ACTIVE", 2, "charlie"),
      makeStale("ACTIVE", 2, "alice"),
      makeStale("ACTIVE", 2, "bob"),
    ];
    const sorted = sortByStaleness(entries);
    expect(sorted.map(e => e.name)).toEqual(["alice", "bob", "charlie"]);
  });

  it("does not mutate input array", () => {
    const entries = [
      makeStale("ACTIVE", 1, "a"),
      makeStale("DEAD", 100, "b"),
    ];
    const copy = [...entries];
    sortByStaleness(entries);
    expect(entries).toEqual(copy);
  });

  it("handles empty array", () => {
    expect(sortByStaleness([])).toEqual([]);
  });

  it("handles single element", () => {
    const entries = [makeStale("STALE", 50, "only")];
    const sorted = sortByStaleness(entries);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].name).toBe("only");
  });
});
