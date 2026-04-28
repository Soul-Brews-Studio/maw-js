/**
 * Tests for resolveByName, resolveSessionTarget, resolveWorktreeTarget
 * from src/core/matcher/resolve-target.ts.
 * Pure name resolution — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { resolveByName, resolveSessionTarget, resolveWorktreeTarget } from "../../src/core/matcher/resolve-target";

type Item = { name: string };
const items: Item[] = [
  { name: "101-mawjs" },
  { name: "102-neo" },
  { name: "103-pulse" },
  { name: "mawjs-view" },
  { name: "neo-debug" },
];

describe("resolveByName", () => {
  it("returns none for empty target", () => {
    expect(resolveByName("", items).kind).toBe("none");
  });

  it("returns none for whitespace target", () => {
    expect(resolveByName("   ", items).kind).toBe("none");
  });

  it("finds exact match (case insensitive)", () => {
    const result = resolveByName("101-mawjs", items);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.match.name).toBe("101-mawjs");
  });

  it("finds exact match case insensitively", () => {
    const result = resolveByName("101-MAWJS", items);
    expect(result.kind).toBe("exact");
  });

  it("finds suffix match (Tier 2a)", () => {
    const result = resolveByName("mawjs", items);
    // "101-mawjs" ends with "-mawjs"
    expect(result.kind).toBe("fuzzy");
    if (result.kind === "fuzzy") expect(result.match.name).toBe("101-mawjs");
  });

  it("finds suffix match for neo", () => {
    const result = resolveByName("neo", items);
    expect(result.kind).toBe("fuzzy");
    if (result.kind === "fuzzy") expect(result.match.name).toBe("102-neo");
  });

  it("returns ambiguous for multiple suffix matches", () => {
    const dupes: Item[] = [{ name: "01-test" }, { name: "02-test" }];
    const result = resolveByName("test", dupes);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates.length).toBe(2);
  });

  it("prefix match (Tier 2b) when no suffix", () => {
    const result = resolveByName("neo-debug", items);
    expect(result.kind).toBe("exact"); // exact wins
  });

  it("returns none with hints for substring-only match", () => {
    const items2: Item[] = [{ name: "foobarqux" }];
    const result = resolveByName("bar", items2);
    expect(result.kind).toBe("none");
    if (result.kind === "none") {
      expect(result.hints).toBeDefined();
      expect(result.hints!.length).toBe(1);
    }
  });

  it("returns none without hints when nothing matches", () => {
    const result = resolveByName("zzz", items);
    expect(result.kind).toBe("none");
    if (result.kind === "none") expect(result.hints).toBeUndefined();
  });

  it("exact wins over suffix", () => {
    const items2: Item[] = [{ name: "view" }, { name: "main-view" }];
    const result = resolveByName("view", items2);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.match.name).toBe("view");
  });
});

describe("resolveSessionTarget", () => {
  it("excludes numeric-prefixed items from Tier 2b", () => {
    // With fleetSessions=true, "114-mawjs-no2" should NOT match "mawjs" via middle-segment
    const items2: Item[] = [{ name: "114-mawjs-no2" }];
    const result = resolveSessionTarget("mawjs", items2);
    // No suffix match (doesn't end with -mawjs), no prefix/middle (fleet excluded)
    expect(result.kind).toBe("none");
  });
});

describe("resolveWorktreeTarget", () => {
  it("allows numeric-prefixed items in Tier 2b", () => {
    const items2: Item[] = [{ name: "2-pay-v1" }];
    const result = resolveWorktreeTarget("pay", items2);
    // Middle segment match: "2-pay-v1" contains "-pay-"
    expect(result.kind).toBe("fuzzy");
  });
});
