/**
 * Tests for src/plugin/registry-semver.ts — satisfies, formatSdkMismatchError.
 * Pure functions, zero dependencies.
 */
import { describe, it, expect } from "bun:test";
import { satisfies, formatSdkMismatchError } from "../../src/plugin/registry-semver";

describe("satisfies", () => {
  // Wildcard
  it("* matches any version", () => {
    expect(satisfies("1.0.0", "*")).toBe(true);
    expect(satisfies("0.0.1", "*")).toBe(true);
    expect(satisfies("99.99.99", "*")).toBe(true);
  });

  // Exact
  it("exact match", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "1.2.4")).toBe(false);
  });

  // Caret (^)
  it("^ — same major (>0)", () => {
    expect(satisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfies("1.9.9", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("0.9.9", "^1.0.0")).toBe(false);
  });

  it("^ — 0.x: same minor", () => {
    expect(satisfies("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
  });

  it("^ — 0.0.x: exact", () => {
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  // Tilde (~)
  it("~ — same major.minor", () => {
    expect(satisfies("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.2.0", "~1.2.0")).toBe(true);
  });

  // Comparison operators
  it(">= operator", () => {
    expect(satisfies("1.0.0", ">=1.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.0.0")).toBe(true);
    expect(satisfies("0.9.9", ">=1.0.0")).toBe(false);
  });

  it("<= operator", () => {
    expect(satisfies("1.0.0", "<=1.0.0")).toBe(true);
    expect(satisfies("0.9.9", "<=1.0.0")).toBe(true);
    expect(satisfies("1.0.1", "<=1.0.0")).toBe(false);
  });

  it("> operator", () => {
    expect(satisfies("1.0.1", ">1.0.0")).toBe(true);
    expect(satisfies("1.0.0", ">1.0.0")).toBe(false);
  });

  it("< operator", () => {
    expect(satisfies("0.9.9", "<1.0.0")).toBe(true);
    expect(satisfies("1.0.0", "<1.0.0")).toBe(false);
  });

  // Edge cases
  it("strips pre-release metadata", () => {
    expect(satisfies("1.2.3-beta.1", "1.2.3")).toBe(true);
  });

  it("strips build metadata", () => {
    expect(satisfies("1.2.3+build.42", "1.2.3")).toBe(true);
  });

  it("returns false for invalid version", () => {
    expect(satisfies("not-a-version", "1.0.0")).toBe(false);
  });

  it("returns false for invalid range", () => {
    expect(satisfies("1.0.0", "not-a-range")).toBe(false);
  });
});

describe("formatSdkMismatchError", () => {
  it("includes plugin name", () => {
    const msg = formatSdkMismatchError("my-plugin", "^2.0.0", "1.5.0");
    expect(msg).toContain("my-plugin");
  });

  it("includes required SDK version", () => {
    const msg = formatSdkMismatchError("p", "^2.0.0", "1.5.0");
    expect(msg).toContain("^2.0.0");
  });

  it("includes runtime version", () => {
    const msg = formatSdkMismatchError("p", "^2.0.0", "1.5.0");
    expect(msg).toContain("1.5.0");
  });

  it("includes fix hints", () => {
    const msg = formatSdkMismatchError("p", "^2.0.0", "1.5.0");
    expect(msg).toContain("maw update");
    expect(msg).toContain("maw plugin install");
  });
});
