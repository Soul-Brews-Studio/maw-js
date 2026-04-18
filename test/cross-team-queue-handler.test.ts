import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { applyFilter } from "../src/commands/plugins/cross-team-queue/filter";
import { computeStats } from "../src/commands/plugins/cross-team-queue/aggregate";
import type { InboxItem, QueueFilter } from "../src/commands/plugins/cross-team-queue/types";

function mkItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    recipient: "neo",
    team: "alpha",
    type: "handoff",
    mtime: 1_700_000_000_000,
    ageHours: 1,
    ...over,
  } as InboxItem;
}

describe("applyFilter", () => {
  const items: InboxItem[] = [
    mkItem({ recipient: "neo", team: "alpha", type: "handoff", ageHours: 1 }),
    mkItem({ recipient: "neo", team: "beta", type: "fyi", ageHours: 5 }),
    mkItem({ recipient: "mawjs", team: "alpha", type: "handoff", ageHours: 24 }),
    mkItem({ recipient: "david", team: "forge", type: "review", ageHours: 100 }),
  ];

  test("empty filter returns all items", () => {
    expect(applyFilter(items, {})).toHaveLength(4);
  });

  test("empty filter returns a NEW array (no mutation)", () => {
    const result = applyFilter(items, {});
    expect(result).not.toBe(items);
    result.pop();
    expect(items).toHaveLength(4);
  });

  test("recipient: exact case-insensitive match", () => {
    expect(applyFilter(items, { recipient: "neo" })).toHaveLength(2);
    expect(applyFilter(items, { recipient: "NEO" })).toHaveLength(2);
    expect(applyFilter(items, { recipient: "Neo" })).toHaveLength(2);
  });

  test("recipient: no match returns empty array (NOT all items)", () => {
    // adversarial: unknown recipient must not silent-drop the filter
    expect(applyFilter(items, { recipient: "ghost" })).toHaveLength(0);
  });

  test("team: exact match", () => {
    expect(applyFilter(items, { team: "alpha" })).toHaveLength(2);
    expect(applyFilter(items, { team: "forge" })).toHaveLength(1);
  });

  test("team: case-sensitive (alpha != ALPHA)", () => {
    expect(applyFilter(items, { team: "ALPHA" })).toHaveLength(0);
  });

  test("type: exact match", () => {
    expect(applyFilter(items, { type: "handoff" })).toHaveLength(2);
    expect(applyFilter(items, { type: "fyi" })).toHaveLength(1);
  });

  test("type: unknown enum filters to empty (not silent-drop to all)", () => {
    // adversarial regression — Bloom's catalogue: unknown enum must
    // not be silently treated as "no filter"
    expect(applyFilter(items, { type: "completely_made_up" })).toHaveLength(0);
  });

  test("maxAgeHours: include items at-or-below threshold", () => {
    expect(applyFilter(items, { maxAgeHours: 5 })).toHaveLength(2);
    expect(applyFilter(items, { maxAgeHours: 24 })).toHaveLength(3);
    expect(applyFilter(items, { maxAgeHours: 1000 })).toHaveLength(4);
    expect(applyFilter(items, { maxAgeHours: 0.5 })).toHaveLength(0);
  });

  test("maxAgeHours: boundary inclusive (ageHours == max)", () => {
    expect(applyFilter(items, { maxAgeHours: 1 }).map((i) => i.ageHours)).toEqual([1]);
  });

  test("combined filters AND together", () => {
    const r = applyFilter(items, { recipient: "neo", team: "alpha" });
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("handoff");
  });

  test("combined: all dimensions narrow correctly", () => {
    const r = applyFilter(items, {
      recipient: "mawjs",
      team: "alpha",
      type: "handoff",
      maxAgeHours: 48,
    });
    expect(r).toHaveLength(1);
  });

  describe("unknown filter keys (forward-compat)", () => {
    let debugCalls: string[] = [];
    let origDebug: typeof console.debug;

    beforeEach(() => {
      debugCalls = [];
      origDebug = console.debug;
      console.debug = (...a: unknown[]) => {
        debugCalls.push(a.map(String).join(" "));
      };
    });
    afterEach(() => {
      console.debug = origDebug;
    });

    test("unknown key is ignored (not silent-failing the filter)", () => {
      // adversarial: passing an unknown key alongside a valid one must
      // NOT cause us to drop all items or ignore the valid filter.
      const filter = { recipient: "neo", futureKey: "xyz" } as unknown as QueueFilter;
      const r = applyFilter(items, filter);
      expect(r).toHaveLength(2);
    });

    test("unknown key emits a debug log (loud signal, not silent)", () => {
      const filter = { someNewDimension: 42 } as unknown as QueueFilter;
      applyFilter(items, filter);
      expect(debugCalls.some((m) => m.includes("someNewDimension"))).toBe(true);
    });

    test("only unknown keys → returns all (empty effective filter)", () => {
      const filter = { foo: "bar" } as unknown as QueueFilter;
      expect(applyFilter(items, filter)).toHaveLength(4);
    });
  });
});

describe("computeStats", () => {
  test("empty input → zeros + null oldest/newest", () => {
    expect(computeStats([])).toEqual({
      totalItems: 0,
      byRecipient: {},
      byType: {},
      oldestAgeHours: null,
      newestAgeHours: null,
    });
  });

  test("single item: that item is both oldest and newest", () => {
    const stats = computeStats([
      mkItem({ recipient: "neo", type: "handoff", ageHours: 7 }),
    ]);
    expect(stats.totalItems).toBe(1);
    expect(stats.byRecipient).toEqual({ neo: 1 });
    expect(stats.byType).toEqual({ handoff: 1 });
    expect(stats.oldestAgeHours).toBe(7);
    expect(stats.newestAgeHours).toBe(7);
  });

  test("multi-item: oldest = max ageHours, newest = min", () => {
    const stats = computeStats([
      mkItem({ ageHours: 1 }),
      mkItem({ ageHours: 50 }),
      mkItem({ ageHours: 12 }),
    ]);
    expect(stats.oldestAgeHours).toBe(50);
    expect(stats.newestAgeHours).toBe(1);
  });

  test("byRecipient counts grouped correctly", () => {
    const stats = computeStats([
      mkItem({ recipient: "neo" }),
      mkItem({ recipient: "neo" }),
      mkItem({ recipient: "mawjs" }),
    ]);
    expect(stats.byRecipient).toEqual({ neo: 2, mawjs: 1 });
  });

  test("byType counts grouped correctly", () => {
    const stats = computeStats([
      mkItem({ type: "handoff" }),
      mkItem({ type: "fyi" }),
      mkItem({ type: "handoff" }),
      mkItem({ type: "review" }),
    ]);
    expect(stats.byType).toEqual({ handoff: 2, fyi: 1, review: 1 });
  });

  test("totalItems matches input length", () => {
    expect(computeStats(Array.from({ length: 17 }, () => mkItem())).totalItems).toBe(17);
  });

  test("items with missing recipient/type don't poison counts", () => {
    const stats = computeStats([
      mkItem({ recipient: "neo", type: "handoff" }),
      mkItem({ recipient: undefined as unknown as string, type: undefined as unknown as string }),
    ]);
    expect(stats.totalItems).toBe(2);
    expect(stats.byRecipient).toEqual({ neo: 1 });
    expect(stats.byType).toEqual({ handoff: 1 });
  });
});
