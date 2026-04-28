/**
 * Tests for parseWakeTarget from src/commands/shared/wake-target.ts.
 * Pure parsing logic — no mocking needed (ensureCloned not tested here).
 */
import { describe, it, expect } from "bun:test";
import { parseWakeTarget } from "../../src/commands/shared/wake-target";

describe("parseWakeTarget", () => {
  it("returns null for plain oracle name", () => {
    expect(parseWakeTarget("neo")).toBeNull();
    expect(parseWakeTarget("pulse-oracle")).toBeNull();
  });

  it("parses HTTPS GitHub URL", () => {
    const result = parseWakeTarget("https://github.com/Soul-Brews-Studio/mawjs-oracle");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("mawjs");
    expect(result!.slug).toBe("Soul-Brews-Studio/mawjs-oracle");
  });

  it("parses HTTPS GitHub URL with .git suffix", () => {
    const result = parseWakeTarget("https://github.com/org/repo.git");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("repo");
    expect(result!.slug).toBe("org/repo");
  });

  it("parses SSH GitHub URL", () => {
    const result = parseWakeTarget("git@github.com:org/repo.git");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("repo");
    expect(result!.slug).toBe("org/repo");
  });

  it("parses GitHub issue URL", () => {
    const result = parseWakeTarget("https://github.com/org/repo/issues/42");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("repo");
    expect(result!.slug).toBe("org/repo");
    expect(result!.issueNum).toBe(42);
  });

  it("strips -oracle suffix from repo name", () => {
    const result = parseWakeTarget("org/neo-oracle");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("neo");
  });

  it("parses org/repo slug", () => {
    const result = parseWakeTarget("kanawutc/maw-js");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("maw-js");
    expect(result!.slug).toBe("kanawutc/maw-js");
  });

  it("handles org/repo with .git suffix", () => {
    const result = parseWakeTarget("org/repo.git");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("repo");
    expect(result!.slug).toBe("org/repo");
  });

  it("trims whitespace", () => {
    const result = parseWakeTarget("  org/repo  ");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("org/repo");
  });

  it("returns null for single segment with slash in middle of name", () => {
    // Not a valid org/repo — would have to match the slug regex
    expect(parseWakeTarget("not/a/valid/path")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseWakeTarget("")).toBeNull();
  });

  it("returns null for string with only whitespace", () => {
    expect(parseWakeTarget("   ")).toBeNull();
  });

  it("handles URL with additional path segments", () => {
    const result = parseWakeTarget("https://github.com/org/repo/tree/main/src");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("org/repo");
  });

  it("no issueNum for non-issue URLs", () => {
    const result = parseWakeTarget("https://github.com/org/repo");
    expect(result).not.toBeNull();
    expect(result!.issueNum).toBeUndefined();
  });

  it("handles repo names with dots and dashes", () => {
    const result = parseWakeTarget("org/my-repo.v2");
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("my-repo.v2");
  });
});
