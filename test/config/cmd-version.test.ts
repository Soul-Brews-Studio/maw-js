/**
 * Tests for getVersionString from src/cli/cmd-version.ts.
 * Runs in actual repo context — git is available.
 */
import { describe, it, expect } from "bun:test";
import { getVersionString } from "../../src/cli/cmd-version";

describe("getVersionString", () => {
  it("starts with 'maw v'", () => {
    const result = getVersionString();
    expect(result.startsWith("maw v")).toBe(true);
  });

  it("contains a semver-like version", () => {
    const result = getVersionString();
    expect(result).toMatch(/maw v\d+\.\d+/);
  });

  it("includes git hash in parens", () => {
    const result = getVersionString();
    // In a git repo, should have (abc1234) style hash
    expect(result).toMatch(/\([a-f0-9]+\)/);
  });

  it("includes build date", () => {
    const result = getVersionString();
    expect(result).toMatch(/built \d{4}-\d{2}-\d{2}/);
  });

  it("returns a non-empty string", () => {
    expect(getVersionString().length).toBeGreaterThan(5);
  });
});
