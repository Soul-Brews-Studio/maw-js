/**
 * Tests for parseCronField, wouldFireAt from src/core/runtime/triggers-cron.ts.
 * Pure cron parsing — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { parseCronField, wouldFireAt } from "../../src/core/runtime/triggers-cron";

// ─── parseCronField ─────────────────────────────────────────────────────────

describe("parseCronField", () => {
  it("parses wildcard", () => {
    const result = parseCronField("*", 0, 59);
    expect(result.size).toBe(60);
    expect(result.has(0)).toBe(true);
    expect(result.has(59)).toBe(true);
  });

  it("parses single number", () => {
    const result = parseCronField("5", 0, 59);
    expect(result.size).toBe(1);
    expect(result.has(5)).toBe(true);
  });

  it("parses list", () => {
    const result = parseCronField("1,3,5", 0, 59);
    expect(result.size).toBe(3);
    expect(result.has(1)).toBe(true);
    expect(result.has(3)).toBe(true);
    expect(result.has(5)).toBe(true);
  });

  it("parses range", () => {
    const result = parseCronField("1-5", 0, 59);
    expect(result.size).toBe(5);
    for (let i = 1; i <= 5; i++) expect(result.has(i)).toBe(true);
  });

  it("parses step on wildcard", () => {
    const result = parseCronField("*/15", 0, 59);
    expect(result.has(0)).toBe(true);
    expect(result.has(15)).toBe(true);
    expect(result.has(30)).toBe(true);
    expect(result.has(45)).toBe(true);
    expect(result.has(1)).toBe(false);
  });

  it("parses step on range", () => {
    const result = parseCronField("1-10/3", 0, 59);
    expect(result.has(1)).toBe(true);
    expect(result.has(4)).toBe(true);
    expect(result.has(7)).toBe(true);
    expect(result.has(10)).toBe(true);
    expect(result.has(2)).toBe(false);
  });

  it("throws for out-of-range values", () => {
    expect(() => parseCronField("60", 0, 59)).toThrow();
  });

  it("throws for negative values", () => {
    expect(() => parseCronField("-1", 0, 59)).toThrow();
  });

  it("throws for reversed range", () => {
    expect(() => parseCronField("5-1", 0, 59)).toThrow();
  });

  it("throws for invalid step", () => {
    expect(() => parseCronField("*/0", 0, 59)).toThrow();
  });

  it("handles hour field", () => {
    const result = parseCronField("9-17", 0, 23);
    expect(result.size).toBe(9);
  });

  it("handles day-of-week field", () => {
    const result = parseCronField("1-5", 0, 6);
    expect(result.size).toBe(5); // Mon-Fri
  });
});

// ─── wouldFireAt ────────────────────────────────────────────────────────────

describe("wouldFireAt", () => {
  it("finds next match for every-minute cron", () => {
    const now = new Date("2026-04-27T10:30:00");
    const next = wouldFireAt("* * * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(31);
  });

  it("finds next match for specific minute", () => {
    const now = new Date("2026-04-27T10:00:00");
    const next = wouldFireAt("30 * * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(30);
  });

  it("advances to next hour if minute already passed", () => {
    const now = new Date("2026-04-27T10:45:00");
    const next = wouldFireAt("30 * * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(11);
    expect(next!.getMinutes()).toBe(30);
  });

  it("finds next match for specific hour and minute", () => {
    const now = new Date("2026-04-27T08:00:00");
    const next = wouldFireAt("0 12 * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(12);
    expect(next!.getMinutes()).toBe(0);
  });

  it("finds next match for specific day of week", () => {
    const now = new Date("2026-04-27T10:00:00"); // Monday (day 1)
    const next = wouldFireAt("0 9 * * 3", now); // Wednesday
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(3);
  });

  it("throws for wrong number of fields", () => {
    expect(() => wouldFireAt("* * *")).toThrow("5 fields");
    expect(() => wouldFireAt("* * * * * *")).toThrow("5 fields");
  });

  it("result is strictly after now", () => {
    const now = new Date("2026-04-27T10:30:00");
    const next = wouldFireAt("30 10 * * *", now);
    expect(next).not.toBeNull();
    // Should be next day at 10:30, not the same minute
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("handles monthly schedule", () => {
    const now = new Date("2026-04-27T10:00:00");
    const next = wouldFireAt("0 0 1 * *", now); // 1st of month
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(1);
    expect(next!.getMonth()).toBe(4); // May (0-indexed)
  });
});
