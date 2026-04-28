/**
 * Tests for sparkline from src/lib/sparkline.ts.
 * Pure Unicode sparkline renderer — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { sparkline } from "../../src/lib/sparkline";

describe("sparkline", () => {
  it("renders max value as full block", () => {
    const result = sparkline([0, 0, 10]);
    expect(result).toContain("█");
  });

  it("renders zero without activity as shade", () => {
    const result = sparkline([0], [false]);
    expect(result).toBe("░");
  });

  it("renders zero with activity as lowest block", () => {
    const result = sparkline([0], [true]);
    expect(result).toBe("▁");
  });

  it("renders all zeros with activity as all lowest blocks", () => {
    const result = sparkline([0, 0, 0], [true, true, true]);
    expect(result).toBe("▁▁▁");
  });

  it("renders mixed activity/inactivity", () => {
    const result = sparkline([5, 0, 10], [true, false, true]);
    expect(result[1]).toBe("░"); // inactive day
    expect(result[2]).toBe("█"); // max
  });

  it("auto-detects activity from positive values", () => {
    const result = sparkline([0, 5, 10]);
    expect(result[0]).toBe("░"); // 0 → inactive
    expect(result[2]).toBe("█"); // max
  });

  it("returns empty string for empty array", () => {
    expect(sparkline([])).toBe("");
  });

  it("handles single value", () => {
    expect(sparkline([42])).toBe("█");
  });

  it("handles uniform non-zero values", () => {
    const result = sparkline([5, 5, 5]);
    expect(result).toBe("███");
  });

  it("produces one char per value", () => {
    const values = [1, 2, 3, 4, 5];
    expect(sparkline(values).length).toBe(5);
  });

  it("produces ascending blocks for ascending values", () => {
    const result = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
    // Each subsequent char should be >= the previous
    for (let i = 1; i < result.length; i++) {
      expect(result.charCodeAt(i)).toBeGreaterThanOrEqual(result.charCodeAt(i - 1));
    }
  });
});
