/**
 * Tests for normalizeTarget from src/core/matcher/normalize-target.ts.
 * Pure string normalization — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { normalizeTarget } from "../../src/core/matcher/normalize-target";

describe("normalizeTarget", () => {
  it("returns clean name unchanged", () => {
    expect(normalizeTarget("foo")).toBe("foo");
  });

  it("strips trailing slash", () => {
    expect(normalizeTarget("foo/")).toBe("foo");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeTarget("foo//")).toBe("foo");
  });

  it("strips trailing .git", () => {
    expect(normalizeTarget("foo/.git")).toBe("foo");
  });

  it("strips trailing .git/", () => {
    expect(normalizeTarget("foo/.git/")).toBe("foo");
  });

  it("trims whitespace", () => {
    expect(normalizeTarget("  foo  ")).toBe("foo");
  });

  it("handles combined slash and whitespace", () => {
    expect(normalizeTarget("  foo/  ")).toBe("foo");
  });

  it("returns empty for empty string", () => {
    expect(normalizeTarget("")).toBe("");
  });

  it("returns empty for whitespace only", () => {
    expect(normalizeTarget("   ")).toBe("");
  });

  it("preserves internal slashes", () => {
    expect(normalizeTarget("org/repo")).toBe("org/repo");
  });

  it("does not lowercase", () => {
    expect(normalizeTarget("FooBar")).toBe("FooBar");
  });

  it("handles non-string input", () => {
    expect(normalizeTarget(undefined as any)).toBe("");
    expect(normalizeTarget(null as any)).toBe("");
  });
});
