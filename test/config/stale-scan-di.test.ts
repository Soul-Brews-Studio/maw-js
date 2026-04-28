/**
 * Tests for runStaleScan from src/commands/plugins/oracle/impl-stale.ts.
 * Uses DI injection for all dependencies — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { runStaleScan } from "../../src/commands/plugins/oracle/impl-stale";
import type { OracleEntry } from "../../src/core/fleet/registry-oracle-types";

function makeEntry(name: string, opts: Partial<OracleEntry> = {}): OracleEntry {
  return {
    name,
    org: "TestOrg",
    repo: `${name}-oracle`,
    local_path: `/tmp/${name}`,
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-01-01",
    ...opts,
  };
}

describe("runStaleScan (DI)", () => {
  const fixedNow = new Date("2026-04-27T12:00:00Z");

  it("returns empty when no entries", async () => {
    const results = await runStaleScan({}, {
      readEntries: () => [],
      listAwake: async () => new Set(),
      getLastCommit: () => null,
      now: () => fixedNow,
    });
    expect(results).toEqual([]);
  });

  it("classifies recent commit as ACTIVE (filtered out by default)", async () => {
    const results = await runStaleScan({}, {
      readEntries: () => [makeEntry("neo")],
      listAwake: async () => new Set(),
      getLastCommit: () => "2026-04-25T12:00:00Z", // 2 days ago
      now: () => fixedNow,
    });
    // ACTIVE is filtered out by default (only STALE+DEAD shown)
    expect(results.length).toBe(0);
  });

  it("classifies recent commit as ACTIVE (shown with opts.all)", async () => {
    const results = await runStaleScan({ all: true }, {
      readEntries: () => [makeEntry("neo")],
      listAwake: async () => new Set(),
      getLastCommit: () => "2026-04-25T12:00:00Z",
      now: () => fixedNow,
    });
    expect(results.length).toBe(1);
    expect(results[0].tier).toBe("ACTIVE");
  });

  it("classifies awake oracle as ACTIVE", async () => {
    const results = await runStaleScan({ all: true }, {
      readEntries: () => [makeEntry("neo")],
      listAwake: async () => new Set(["neo"]),
      getLastCommit: () => null,
      now: () => fixedNow,
    });
    expect(results[0].tier).toBe("ACTIVE");
    expect(results[0].awake).toBe(true);
  });

  it("classifies old commit as STALE", async () => {
    const results = await runStaleScan({}, {
      readEntries: () => [makeEntry("old")],
      listAwake: async () => new Set(),
      getLastCommit: () => "2026-02-01T12:00:00Z", // ~85 days ago
      now: () => fixedNow,
    });
    expect(results.length).toBe(1);
    expect(results[0].tier).toBe("STALE");
  });

  it("classifies very old commit as DEAD", async () => {
    const results = await runStaleScan({}, {
      readEntries: () => [makeEntry("dead")],
      listAwake: async () => new Set(),
      getLastCommit: () => "2025-12-01T12:00:00Z", // ~147 days ago
      now: () => fixedNow,
    });
    expect(results[0].tier).toBe("DEAD");
  });

  it("classifies null commit as DEAD", async () => {
    const results = await runStaleScan({}, {
      readEntries: () => [makeEntry("ghost")],
      listAwake: async () => new Set(),
      getLastCommit: () => null,
      now: () => fixedNow,
    });
    expect(results[0].tier).toBe("DEAD");
  });

  it("sorts DEAD before STALE", async () => {
    const results = await runStaleScan({}, {
      readEntries: () => [
        makeEntry("stale1"),
        makeEntry("dead1"),
      ],
      listAwake: async () => new Set(),
      getLastCommit: (p) => p.includes("stale") ? "2026-02-01T12:00:00Z" : null,
      now: () => fixedNow,
    });
    expect(results[0].tier).toBe("DEAD");
    expect(results[1].tier).toBe("STALE");
  });

  it("processes multiple entries", async () => {
    const results = await runStaleScan({ all: true }, {
      readEntries: () => [makeEntry("a"), makeEntry("b"), makeEntry("c")],
      listAwake: async () => new Set(["a"]),
      getLastCommit: () => "2026-04-20T00:00:00Z",
      now: () => fixedNow,
    });
    expect(results.length).toBe(3);
  });
});
