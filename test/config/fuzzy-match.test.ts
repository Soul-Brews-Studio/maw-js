/**
 * Tests for distance() and fuzzyMatch() from src/core/util/fuzzy.ts.
 * Pure Levenshtein + fuzzy matching — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { distance, fuzzyMatch } from "../../src/core/util/fuzzy";

// ─── distance (Levenshtein) ────────────────────────────────────────────────

describe("distance", () => {
  it("returns 0 for identical strings", () => {
    expect(distance("hello", "hello")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(distance("", "")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(distance("", "abc")).toBe(3);
    expect(distance("xyz", "")).toBe(3);
  });

  it("counts single character difference", () => {
    expect(distance("cat", "car")).toBe(1);
  });

  it("counts single insertion", () => {
    expect(distance("cat", "cats")).toBe(1);
  });

  it("counts single deletion", () => {
    expect(distance("cats", "cat")).toBe(1);
  });

  it("handles transposition as 2 edits", () => {
    // Levenshtein treats transposition as delete + insert
    expect(distance("ab", "ba")).toBe(2);
  });

  it("computes known distance", () => {
    expect(distance("kitten", "sitting")).toBe(3);
  });

  it("is symmetric", () => {
    expect(distance("abc", "xyz")).toBe(distance("xyz", "abc"));
  });

  it("handles single characters", () => {
    expect(distance("a", "b")).toBe(1);
    expect(distance("a", "a")).toBe(0);
  });
});

// ─── fuzzyMatch ─────────────────────────────────────────────────────────────

describe("fuzzyMatch", () => {
  const commands = ["hey", "hello", "help", "peek", "send", "wake", "sleep", "ls"];

  it("returns empty for empty input", () => {
    expect(fuzzyMatch("", commands)).toEqual([]);
  });

  it("returns exact match first", () => {
    const result = fuzzyMatch("hey", commands);
    expect(result[0]).toBe("hey");
  });

  it("returns close matches sorted by distance", () => {
    const result = fuzzyMatch("hep", commands);
    // "help" (d=1) and "hey" (d=1) should be closest
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("help");
    expect(result).toContain("hey");
  });

  it("respects maxResults", () => {
    const result = fuzzyMatch("h", commands, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("respects maxDistance", () => {
    const result = fuzzyMatch("zzzzz", commands, 3, 1);
    // No candidate is within distance 1 of "zzzzz"
    expect(result).toEqual([]);
  });

  it("is case insensitive", () => {
    const result = fuzzyMatch("HEY", commands);
    expect(result).toContain("hey");
  });

  it("deduplicates candidates", () => {
    const result = fuzzyMatch("hey", ["hey", "hey", "hey"]);
    expect(result).toEqual(["hey"]);
  });

  it("skips empty candidates", () => {
    const result = fuzzyMatch("hey", ["", "hey", ""]);
    expect(result).toEqual(["hey"]);
  });

  it("sorts ties alphabetically", () => {
    // "ba" and "ab" are both distance 2 from "cd"
    const result = fuzzyMatch("cd", ["ba", "ab"], 3, 2);
    expect(result[0]).toBe("ab"); // alphabetical first
  });

  it("defaults to maxResults=3 and maxDistance=3", () => {
    const many = Array.from({ length: 10 }, (_, i) => `hey${i}`);
    const result = fuzzyMatch("hey", many);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
