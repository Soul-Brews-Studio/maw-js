/**
 * Tests for src/core/matcher/resolve-target.ts — resolveByName, resolveSessionTarget,
 * resolveWorktreeTarget.
 *
 * Pure functions with a clear 4-tier resolution cascade.
 */
import { describe, it, expect } from "bun:test";
import { resolveByName, resolveSessionTarget, resolveWorktreeTarget } from "../../src/core/matcher/resolve-target";

type Named = { name: string };
const items: Named[] = [
  { name: "101-mawjs" },
  { name: "102-homekeeper" },
  { name: "mawjs-view" },
  { name: "103-pimquin" },
  { name: "dev" },
];

// ─── Tier 1: Exact match ──────────────────────────────────────────

describe("resolveByName — exact", () => {
  it("matches exact name", () => {
    const r = resolveByName("dev", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("dev");
  });

  it("matches exact case-insensitive", () => {
    const r = resolveByName("DEV", items);
    expect(r.kind).toBe("exact");
  });

  it("trims whitespace", () => {
    const r = resolveByName("  dev  ", items);
    expect(r.kind).toBe("exact");
  });

  it("returns none for empty target", () => {
    expect(resolveByName("", items).kind).toBe("none");
  });

  it("returns none for whitespace-only target", () => {
    expect(resolveByName("   ", items).kind).toBe("none");
  });
});

// ─── Tier 2a: Suffix word-segment (*-target) ──────────────────────

describe("resolveByName — suffix", () => {
  it("matches suffix segment (mawjs → 101-mawjs)", () => {
    const r = resolveByName("mawjs", items);
    // Could be fuzzy (suffix) or ambiguous if mawjs-view also suffix-matches
    // "mawjs" → endsWith("-mawjs") matches "101-mawjs" only (mawjs-view doesn't end with -mawjs)
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("101-mawjs");
  });

  it("matches suffix segment (homekeeper)", () => {
    const r = resolveByName("homekeeper", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("102-homekeeper");
  });

  it("ambiguous when multiple suffix matches", () => {
    const dupes: Named[] = [{ name: "01-agent" }, { name: "02-agent" }];
    const r = resolveByName("agent", dupes);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });
});

// ─── Tier 2b: Prefix/middle word-segment ──────────────────────────

describe("resolveByName — prefix/middle", () => {
  it("matches prefix segment (mawjs → mawjs-view)", () => {
    // "view" → endsWith("-view") matches "mawjs-view" → suffix match, fuzzy
    const r = resolveByName("view", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-view");
  });

  it("with fleetSessions, numeric-prefixed items excluded from 2b", () => {
    // Items where sub-segment would incorrectly match oracle sessions
    const fleet: Named[] = [
      { name: "114-mawjs-no2" },
      { name: "mawjs-debug" },
    ];
    // "mawjs" suffix-matches "114-mawjs-no2" via endsWith("-mawjs-no2")? No.
    // It doesn't suffix-match anything. Then 2b: "mawjs-" prefix or "-mawjs-" middle.
    // "114-mawjs-no2" has "-mawjs-" in middle → match, but fleetSessions excludes numeric prefix
    // "mawjs-debug" starts with "mawjs-" → match
    const r = resolveByName("mawjs", fleet, { fleetSessions: true });
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-debug");
  });
});

// ─── Tier 3: Substring fallback (hints only) ──────────────────────

describe("resolveByName — substring hints", () => {
  it("returns none with hints for substring match", () => {
    const r = resolveByName("keep", items);
    // "keep" → no exact, no suffix "-keep", no prefix "keep-" or middle "-keep-"
    // but "102-homekeeper" includes "keep" → hint
    expect(r.kind).toBe("none");
    if (r.kind === "none") {
      expect(r.hints).toBeDefined();
      expect(r.hints!.length).toBeGreaterThan(0);
    }
  });

  it("returns none without hints for totally unknown", () => {
    const r = resolveByName("zzzzz", items);
    expect(r.kind).toBe("none");
    if (r.kind === "none") expect(r.hints).toBeUndefined();
  });
});

// ─── Convenience wrappers ─────────────────────────────────────────

describe("resolveSessionTarget", () => {
  it("uses fleetSessions: true", () => {
    const fleet: Named[] = [
      { name: "114-mawjs-no2" },
      { name: "mawjs-aux" },
    ];
    const r = resolveSessionTarget("mawjs", fleet);
    // fleetSessions=true → 2b excludes "114-mawjs-no2"
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-aux");
  });
});

describe("resolveWorktreeTarget", () => {
  it("does NOT use fleetSessions (numeric prefixes match in 2b)", () => {
    const wt: Named[] = [
      { name: "2-pay-v1" },
    ];
    const r = resolveWorktreeTarget("pay", wt);
    // No suffix "-pay" match (name is "2-pay-v1")
    // 2b: "-pay-" middle match → fuzzy (numeric prefix NOT excluded)
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("2-pay-v1");
  });
});
