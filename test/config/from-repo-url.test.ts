/**
 * Tests for src/commands/plugins/bud/from-repo.ts — looksLikeUrl.
 * Pure heuristic check.
 */
import { describe, it, expect } from "bun:test";
import { looksLikeUrl } from "../../src/commands/plugins/bud/from-repo";

describe("looksLikeUrl", () => {
  it("detects https URL", () => {
    expect(looksLikeUrl("https://github.com/org/repo")).toBe(true);
  });

  it("detects http URL", () => {
    expect(looksLikeUrl("http://git.internal/org/repo")).toBe(true);
  });

  it("detects git@ SSH URL", () => {
    expect(looksLikeUrl("git@github.com:org/repo.git")).toBe(true);
  });

  it("detects org/repo slug", () => {
    expect(looksLikeUrl("soul-brews/maw-js")).toBe(true);
  });

  it("rejects absolute path", () => {
    expect(looksLikeUrl("/home/user/repo")).toBe(false);
  });

  it("rejects relative path with dot", () => {
    expect(looksLikeUrl("./my-repo")).toBe(false);
  });

  it("rejects bare name (no slash)", () => {
    expect(looksLikeUrl("my-repo")).toBe(false);
  });

  it("rejects nested path (too many slashes)", () => {
    expect(looksLikeUrl("a/b/c")).toBe(false);
  });

  it("accepts single-char org/repo", () => {
    expect(looksLikeUrl("a/b")).toBe(true);
  });
});
