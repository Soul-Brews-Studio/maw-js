/**
 * Tests for sanitizeLogField from src/core/util/sanitize-log.ts.
 * Pure function — security-critical log injection prevention.
 */
import { describe, it, expect } from "bun:test";
import { sanitizeLogField } from "../../src/core/util/sanitize-log";

describe("sanitizeLogField", () => {
  // ─── Basic coercion ─────────────────────────────────────────────────────

  it("passes through normal strings unchanged", () => {
    expect(sanitizeLogField("hello world")).toBe("hello world");
  });

  it("coerces numbers to string", () => {
    expect(sanitizeLogField(42)).toBe("42");
  });

  it("coerces undefined to 'undefined'", () => {
    expect(sanitizeLogField(undefined)).toBe("undefined");
  });

  it("coerces null to 'null'", () => {
    expect(sanitizeLogField(null)).toBe("null");
  });

  it("coerces objects to string", () => {
    expect(sanitizeLogField({ a: 1 })).toBe("[object Object]");
  });

  it("handles unstringifiable objects", () => {
    const bad = { toString() { throw new Error("boom"); } };
    expect(sanitizeLogField(bad)).toBe("[unstringifiable]");
  });

  // ─── Newline injection ───────────────────────────────────────────────────

  it("replaces newlines with visible markers", () => {
    const result = sanitizeLogField("line1\nline2\rline3");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
    expect(result).toContain("\\x0a"); // \n
    expect(result).toContain("\\x0d"); // \r
  });

  // ─── ANSI escape sequences ──────────────────────────────────────────────

  it("strips ANSI CSI color codes", () => {
    const result = sanitizeLogField("\x1b[31mred text\x1b[0m");
    expect(result).not.toContain("\x1b");
    expect(result).toContain("red text");
  });

  it("strips ANSI OSC sequences", () => {
    const result = sanitizeLogField("\x1b]0;title\x07rest");
    expect(result).not.toContain("\x1b");
    expect(result).toContain("rest");
  });

  // ─── Control characters ─────────────────────────────────────────────────

  it("replaces NUL byte", () => {
    const result = sanitizeLogField("hello\x00world");
    expect(result).toContain("\\x00");
    expect(result).not.toContain("\x00");
  });

  it("replaces BEL byte", () => {
    const result = sanitizeLogField("alert\x07me");
    expect(result).not.toContain("\x07");
  });

  it("replaces backspace (BS)", () => {
    const result = sanitizeLogField("over\x08write");
    expect(result).toContain("\\x08");
  });

  it("replaces DEL (0x7f)", () => {
    const result = sanitizeLogField("del\x7fete");
    expect(result).toContain("\\x7f");
  });

  it("preserves tabs", () => {
    expect(sanitizeLogField("col1\tcol2")).toBe("col1\tcol2");
  });

  // ─── Truncation ─────────────────────────────────────────────────────────

  it("truncates at default 200 chars", () => {
    const long = "x".repeat(300);
    const result = sanitizeLogField(long);
    expect(result.length).toBeLessThan(300);
    expect(result).toContain("…[+");
  });

  it("truncation marker shows dropped count", () => {
    const long = "x".repeat(210);
    const result = sanitizeLogField(long);
    expect(result).toContain("…[+10]");
  });

  it("respects custom maxLen", () => {
    const result = sanitizeLogField("hello world", 5);
    expect(result).toContain("…[+");
  });

  it("disables truncation with maxLen=0", () => {
    const long = "x".repeat(500);
    const result = sanitizeLogField(long, 0);
    expect(result.length).toBe(500);
  });

  it("does not truncate when within limit", () => {
    const result = sanitizeLogField("short", 200);
    expect(result).toBe("short");
  });

  // ─── Combined attack vectors ────────────────────────────────────────────

  it("handles combined ANSI + newline + control attack", () => {
    const attack = "\x1b[31mFAKE LOG\x1b[0m\n2026-04-27 | attacker | SPOOFED";
    const result = sanitizeLogField(attack);
    expect(result).not.toContain("\x1b");
    expect(result).not.toContain("\n");
    expect(result).toContain("FAKE LOG");
    expect(result).toContain("\\x0a");
  });

  it("empty string passes through", () => {
    expect(sanitizeLogField("")).toBe("");
  });
});
