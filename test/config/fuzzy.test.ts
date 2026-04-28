/**
 * Tests for src/core/util/fuzzy.ts — Levenshtein distance + fuzzyMatch.
 * Pure functions, zero dependencies.
 */
import { describe, it, expect } from "bun:test";
import { distance, fuzzyMatch } from "../../src/core/util/fuzzy";

// ─── distance ────────────────────────────────────────────────────

describe("distance", () => {
  it("returns 0 for identical strings", () => {
    expect(distance("abc", "abc")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(distance("", "")).toBe(0);
  });

  it("returns length of other when one is empty", () => {
    expect(distance("", "abc")).toBe(3);
    expect(distance("xyz", "")).toBe(3);
  });

  it("returns 1 for single substitution", () => {
    expect(distance("cat", "car")).toBe(1);
  });

  it("returns 1 for single insertion", () => {
    expect(distance("cat", "cats")).toBe(1);
  });

  it("returns 1 for single deletion", () => {
    expect(distance("cats", "cat")).toBe(1);
  });

  it("computes correct distance for kitten→sitting", () => {
    // Classic example: kitten → sitten → sittin → sitting = 3
    expect(distance("kitten", "sitting")).toBe(3);
  });

  it("computes correct distance for completely different strings", () => {
    expect(distance("abc", "xyz")).toBe(3);
  });

  it("is symmetric", () => {
    expect(distance("hello", "hallo")).toBe(distance("hallo", "hello"));
  });
});

// ─── fuzzyMatch ──────────────────────────────────────────────────

describe("fuzzyMatch", () => {
  const candidates = ["status", "start", "stop", "peek", "hey", "federation", "wake"];

  it("returns exact match first", () => {
    const result = fuzzyMatch("status", candidates);
    expect(result[0]).toBe("status");
  });

  it("returns close matches for typos", () => {
    const result = fuzzyMatch("statu", candidates);
    expect(result).toContain("status");
  });

  it("is case insensitive", () => {
    const result = fuzzyMatch("STATUS", candidates);
    expect(result).toContain("status");
  });

  it("respects maxResults", () => {
    const result = fuzzyMatch("st", candidates, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("respects maxDistance", () => {
    const result = fuzzyMatch("zzzzz", candidates, 3, 1);
    expect(result).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(fuzzyMatch("", candidates)).toEqual([]);
  });

  it("deduplicates candidates", () => {
    const dupes = ["status", "status", "start"];
    const result = fuzzyMatch("status", dupes);
    expect(result.filter((r) => r === "status")).toHaveLength(1);
  });

  it("sorts by distance then alphabetically", () => {
    const result = fuzzyMatch("stop", ["stap", "step", "stop", "stip"]);
    expect(result[0]).toBe("stop"); // distance 0
    // stap, step, stip all distance 1, alphabetical
    expect(result[1]).toBe("stap");
    expect(result[2]).toBe("step");
  });

  it("skips empty candidates", () => {
    const result = fuzzyMatch("abc", ["", "abc", ""]);
    expect(result).toEqual(["abc"]);
  });
});
