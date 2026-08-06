import { describe, it, expect } from "bun:test";
import {
  classifyStaleness,
  sortByStaleness,
  runStaleScan,
  type StaleEntry,
} from "./impl-stale";
import type { OracleEntry } from "../../../sdk";

const NOW = new Date("2026-04-17T12:00:00Z");

function entry(partial: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: "test-oracle",
    name: "test",
    local_path: "/tmp/test-oracle",
    has_psi: true,
    has_fleet_config: true,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: NOW.toISOString(),
    ...partial,
  };
}

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

describe("classifyStaleness", () => {
  it("awake oracles are always ACTIVE regardless of age", () => {
    const r = classifyStaleness({ entry: entry(), lastCommitISO: iso(200), awake: true, now: NOW });
    expect(r.tier).toBe("ACTIVE");
    expect(r.recommendation).toContain("awake");
  });

  it("< 7 days = ACTIVE", () => {
    expect(classifyStaleness({ entry: entry(), lastCommitISO: iso(3), awake: false, now: NOW }).tier).toBe("ACTIVE");
  });

  it("7–30 days = SLOW", () => {
    expect(classifyStaleness({ entry: entry(), lastCommitISO: iso(15), awake: false, now: NOW }).tier).toBe("SLOW");
  });

  it("30–90 days = STALE", () => {
    expect(classifyStaleness({ entry: entry(), lastCommitISO: iso(60), awake: false, now: NOW }).tier).toBe("STALE");
  });

  it("> 90 days = DEAD", () => {
    const r = classifyStaleness({ entry: entry({ has_psi: false }), lastCommitISO: iso(120), awake: false, now: NOW });
    expect(r.tier).toBe("DEAD");
    expect(r.recommendation).toContain("prune");
  });

  it("DEAD with ψ/ recommends archive not prune", () => {
    const r = classifyStaleness({ entry: entry({ has_psi: true }), lastCommitISO: iso(120), awake: false, now: NOW });
    expect(r.tier).toBe("DEAD");
    expect(r.recommendation).toContain("archive");
  });

  it("null commit date = DEAD", () => {
    const r = classifyStaleness({ entry: entry(), lastCommitISO: null, awake: false, now: NOW });
    expect(r.tier).toBe("DEAD");
    expect(r.days_since_commit).toBeNull();
  });

  it("boundary day 7 is SLOW (not ACTIVE)", () => {
    expect(classifyStaleness({ entry: entry(), lastCommitISO: iso(7), awake: false, now: NOW }).tier).toBe("SLOW");
  });

  it("boundary day 90 is DEAD (not STALE)", () => {
    expect(classifyStaleness({ entry: entry(), lastCommitISO: iso(90), awake: false, now: NOW }).tier).toBe("DEAD");
  });
});

describe("sortByStaleness", () => {
  it("DEAD first, then STALE, then SLOW, then ACTIVE", () => {
    const input: StaleEntry[] = [
      { ...stub("a"), tier: "ACTIVE", days_since_commit: 2 },
      { ...stub("b"), tier: "DEAD", days_since_commit: 200 },
      { ...stub("c"), tier: "STALE", days_since_commit: 60 },
      { ...stub("d"), tier: "SLOW", days_since_commit: 20 },
    ];
    const out = sortByStaleness(input);
    expect(out.map((e) => e.tier)).toEqual(["DEAD", "STALE", "SLOW", "ACTIVE"]);
  });

  it("within tier, oldest first", () => {
    const input: StaleEntry[] = [
      { ...stub("young"), tier: "STALE", days_since_commit: 31 },
      { ...stub("old"), tier: "STALE", days_since_commit: 85 },
      { ...stub("mid"), tier: "STALE", days_since_commit: 60 },
    ];
    const out = sortByStaleness(input);
    expect(out.map((e) => e.name)).toEqual(["old", "mid", "young"]);
  });
});

describe("runStaleScan (injected deps)", () => {
  it("classifies from mocked fleet + tmux + git", async () => {
    const entries = [
      entry({ name: "alive", local_path: "/tmp/alive" }),
      entry({ name: "dusty", local_path: "/tmp/dusty" }),
      entry({ name: "dead", local_path: "/tmp/dead", has_psi: false }),
      entry({ name: "awake", local_path: "/tmp/awake" }),
    ];
    const commits: Record<string, string | null> = {
      "/tmp/alive": iso(1),
      "/tmp/dusty": iso(60),
      "/tmp/dead": iso(120),
      "/tmp/awake": iso(200),
    };
    const result = await runStaleScan(
      { all: true },
      {
        readEntries: () => entries,
        listAwake: async () => new Set(["awake"]),
        getLastCommit: (p) => commits[p] ?? null,
        now: () => NOW,
      },
    );
    const byName = Object.fromEntries(result.map((r) => [r.name, r.tier]));
    expect(byName.alive).toBe("ACTIVE");
    expect(byName.dusty).toBe("STALE");
    expect(byName.dead).toBe("DEAD");
    expect(byName.awake).toBe("ACTIVE");  // tmux overrides old commit
  });

  it("default filter hides ACTIVE + SLOW", async () => {
    const entries = [
      entry({ name: "fresh", local_path: "/tmp/fresh" }),
      entry({ name: "rotting", local_path: "/tmp/rotting" }),
    ];
    const result = await runStaleScan(
      {},  // no --all
      {
        readEntries: () => entries,
        listAwake: async () => new Set(),
        getLastCommit: (p) => (p === "/tmp/fresh" ? iso(1) : iso(60)),
        now: () => NOW,
      },
    );
    expect(result.map((r) => r.name)).toEqual(["rotting"]);
  });

  it("handles missing git history (null commit) → DEAD", async () => {
    const entries = [entry({ name: "ghost", local_path: "" })];
    const result = await runStaleScan(
      {},
      {
        readEntries: () => entries,
        listAwake: async () => new Set(),
        getLastCommit: () => null,
        now: () => NOW,
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("DEAD");
  });
});

function stub(name: string): StaleEntry {
  return {
    name,
    org: "x",
    repo: `${name}-oracle`,
    local_path: `/tmp/${name}`,
    has_psi: true,
    awake: false,
    last_commit: null,
    days_since_commit: null,
    tier: "DEAD",
    recommendation: "",
  };
}
