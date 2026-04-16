import { describe, it, expect } from "bun:test";
import { distance, fuzzyMatch } from "../src/core/util/fuzzy";

describe("distance", () => {
  it("distance('oracle', 'oracl') = 1", () => {
    expect(distance("oracle", "oracl")).toBe(1);
  });
  it("distance('hey', 'hek') = 1", () => {
    expect(distance("hey", "hek")).toBe(1);
  });
  it("empty inputs", () => {
    expect(distance("", "")).toBe(0);
    expect(distance("abc", "")).toBe(3);
    expect(distance("", "abc")).toBe(3);
  });
  it("exact match → 0", () => {
    expect(distance("plugin", "plugin")).toBe(0);
  });
  it("substitution + insertion", () => {
    expect(distance("kitten", "sitting")).toBe(3);
  });
});

describe("fuzzyMatch", () => {
  const pool = ["oracle", "plugin", "peek", "hey", "ping", "find", "fleet"];

  it("returns top-3 closest matches, sorted by distance", () => {
    const r = fuzzyMatch("oracl", pool);
    expect(r[0]).toBe("oracle");
    expect(r.length).toBeLessThanOrEqual(3);
  });
  it("suggests 'hey' for 'hek'", () => {
    expect(fuzzyMatch("hek", pool)).toContain("hey");
  });
  it("empty input returns empty", () => {
    expect(fuzzyMatch("", pool)).toEqual([]);
  });
  it("returns empty when nothing within maxDistance", () => {
    expect(fuzzyMatch("xyz-not-a-command", pool)).toEqual([]);
  });
  it("is case-insensitive", () => {
    expect(fuzzyMatch("ORACL", pool)).toContain("oracle");
  });
  it("deduplicates candidates", () => {
    const r = fuzzyMatch("oracle", ["oracle", "oracle", "oracl"]);
    expect(r.filter(n => n === "oracle").length).toBe(1);
  });
});
