/**
 * Tests for src/core/consent/gate-plugin-install.ts — shortSha.
 * Pure string helper, no side effects.
 */
import { describe, it, expect } from "bun:test";
import { shortSha } from "../../src/core/consent/gate-plugin-install";

describe("shortSha", () => {
  it("returns first 8 hex chars of plain hex", () => {
    expect(shortSha("abcdef1234567890")).toBe("abcdef12");
  });

  it("strips sha256: prefix before slicing", () => {
    expect(shortSha("sha256:abcdef1234567890")).toBe("abcdef12");
  });

  it("returns <no sha> for null", () => {
    expect(shortSha(null)).toBe("<no sha>");
  });

  it("returns <no sha> for undefined", () => {
    expect(shortSha(undefined)).toBe("<no sha>");
  });

  it("returns <no sha> for empty string", () => {
    expect(shortSha("")).toBe("<no sha>");
  });

  it("handles short hash (< 8 chars)", () => {
    expect(shortSha("abc")).toBe("abc");
  });

  it("handles exactly 8 chars", () => {
    expect(shortSha("12345678")).toBe("12345678");
  });
});
