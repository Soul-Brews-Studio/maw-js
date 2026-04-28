/**
 * Tests for pure helpers from src/commands/shared/pulse-thread.ts.
 * todayDate, todayLabel, timePeriod, PERIODS — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { todayDate, todayLabel, timePeriod, PERIODS } from "../../src/commands/shared/pulse-thread";

describe("todayDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = todayDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns today's date", () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(todayDate()).toBe(expected);
  });
});

describe("todayLabel", () => {
  it("includes the date", () => {
    expect(todayLabel()).toContain(todayDate());
  });

  it("includes parenthesized Thai day name", () => {
    const result = todayLabel();
    expect(result).toMatch(/\(.+\)$/);
  });
});

describe("timePeriod", () => {
  it("returns a valid period string", () => {
    const valid = ["morning", "afternoon", "evening", "midnight"];
    expect(valid).toContain(timePeriod());
  });
});

describe("PERIODS", () => {
  it("has 4 periods", () => {
    expect(PERIODS).toHaveLength(4);
  });

  it("covers all 24 hours without gaps", () => {
    const keys = PERIODS.map(p => p.key);
    expect(keys).toEqual(["morning", "afternoon", "evening", "midnight"]);
  });

  it("each period has key, label, and hours", () => {
    for (const p of PERIODS) {
      expect(typeof p.key).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(p.hours).toHaveLength(2);
      expect(typeof p.hours[0]).toBe("number");
      expect(typeof p.hours[1]).toBe("number");
    }
  });

  it("hours span the full day (0-24)", () => {
    const starts = PERIODS.map(p => p.hours[0]).sort((a, b) => a - b);
    expect(starts).toEqual([0, 6, 12, 18]);
    const ends = PERIODS.map(p => p.hours[1]).sort((a, b) => a - b);
    expect(ends).toEqual([6, 12, 18, 24]);
  });
});
