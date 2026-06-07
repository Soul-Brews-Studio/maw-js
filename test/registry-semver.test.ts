import { describe, expect, test } from "bun:test";
import { formatSdkMismatchError, satisfies } from "../src/plugin/registry-semver";

describe("plugin registry semver helpers", () => {
  test("rejects invalid versions and invalid ranges", () => {
    expect(satisfies("not-a-version", "*")).toBe(false);
    expect(satisfies("1.2", "*")).toBe(false);
    expect(satisfies("1.2.3", "garbage")).toBe(false);
    expect(satisfies("1.2.3", ">=")).toBe(false);
    expect(satisfies("1.2.3", "^bad")).toBe(false);
  });

  test("supports wildcard, whitespace, exact matches, prerelease, and build metadata", () => {
    expect(satisfies("0.0.0", "*")).toBe(true);
    expect(satisfies(" 1.2.3 ", " 1.2.3 ")).toBe(true);
    expect(satisfies("1.2.3-alpha.1", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3+build.7", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });

  test.each([
    ["1.2.3", "^1.2.3", true],
    ["1.3.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["1.2.2", "^1.2.3", false],
    ["0.2.4", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.2.2", "^0.2.3", false],
    ["1.2.3", "^0.2.3", false],
    ["0.0.5", "^0.0.5", true],
    ["0.0.6", "^0.0.5", false],
    ["0.1.5", "^0.0.5", false],
  ])("caret range %s satisfies %s => %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test.each([
    ["1.2.3", "~1.2.3", true],
    ["1.2.99", "~1.2.3", true],
    ["1.2.2", "~1.2.3", false],
    ["1.3.0", "~1.2.3", false],
    ["2.2.3", "~1.2.3", false],
  ])("tilde range %s satisfies %s => %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test.each([
    ["1.2.3", ">=1.2.3", true],
    ["2.0.0", ">=1.2.3", true],
    ["1.2.2", ">=1.2.3", false],
    ["1.2.3", "<=1.2.3", true],
    ["0.9.9", "<=1.2.3", true],
    ["1.2.4", "<=1.2.3", false],
    ["1.2.4", ">1.2.3", true],
    ["1.2.3", ">1.2.3", false],
    ["1.2.2", ">1.2.3", false],
    ["1.2.2", "<1.2.3", true],
    ["1.2.3", "<1.2.3", false],
    ["1.2.4", "<1.2.3", false],
    ["2.0.0", ">1.99.99", true],
    ["1.3.0", ">1.2.99", true],
  ])("comparison range %s satisfies %s => %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test("formatSdkMismatchError renders the canonical multi-line fix text", () => {
    const out = formatSdkMismatchError("cool-plug", "^2.0.0", "1.9.3");
    const lines = out.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("\x1b[31m✗\x1b[0m plugin 'cool-plug' requires maw SDK ^2.0.0");
    expect(lines[1]).toContain("your maw: 1.9.3  (SDK 1.9.3)");
    expect(lines[2]).toBe("");
    expect(lines[3]).toContain("fix:");
    expect(out).toContain("maw update");
    expect(out).toContain("maw plugin install cool-plug@<old-version>");
    expect(out).toContain('edit plugin.json "sdk"');
  });
});
