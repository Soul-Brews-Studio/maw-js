import { describe, it, expect } from "bun:test";
import { GhqDiscovery, detectFromCwdPath, stripOracleRepoSuffix } from "./ghq-discovery";

/**
 * #2573 — RepoDiscovery.detectFromCwd contract. The pure path helper is also
 * exported directly for callers that need cwd-pass-through semantics; the
 * method on the singleton defaults to process.cwd() when cwd is omitted.
 */

describe("stripOracleRepoSuffix", () => {
  it("strips trailing -oracle case-insensitively, preserves stem case", () => {
    expect(stripOracleRepoSuffix("mawjs-oracle")).toBe("mawjs");
    expect(stripOracleRepoSuffix("Discord-Oracle")).toBe("Discord");
  });
  it("returns null without the suffix", () => {
    expect(stripOracleRepoSuffix("maw-js")).toBeNull();
    expect(stripOracleRepoSuffix("oracle")).toBeNull();
  });
});

describe("detectFromCwdPath", () => {
  it("recognizes a plain <name>-oracle repo dir", () => {
    expect(detectFromCwdPath("/o/mawjs-oracle")).toEqual({ oracle: "mawjs" });
  });
  it("recognizes the nested agents/<slug> worktree layout", () => {
    expect(detectFromCwdPath("/o/mawjs-oracle/agents/1-fix-2573"))
      .toEqual({ oracle: "mawjs", worktree: "1-fix-2573" });
  });
  it("recognizes the legacy .wt-<slug> worktree dir", () => {
    expect(detectFromCwdPath("/o/mawjs-oracle.wt-white"))
      .toEqual({ oracle: "mawjs", worktree: "white" });
  });
  it("returns null for non-oracle source repos and empty paths", () => {
    expect(detectFromCwdPath("/opt/Code/github.com/Soul-Brews-Studio/maw-js")).toBeNull();
    expect(detectFromCwdPath("")).toBeNull();
    expect(detectFromCwdPath(undefined)).toBeNull();
    expect(detectFromCwdPath("/")).toBeNull();
  });
});

describe("GhqDiscovery.detectFromCwd", () => {
  it("delegates to the path helper for explicit cwd", () => {
    expect(GhqDiscovery.detectFromCwd("/o/mawjs-oracle/agents/1-codex-1"))
      .toEqual({ oracle: "mawjs", worktree: "1-codex-1" });
  });
  it("falls back to process.cwd() when cwd is omitted (no throw)", () => {
    // We can't assert the exact result (depends on where tests run), but the
    // method must not throw and must return either null or RepoDetectResult.
    expect(() => GhqDiscovery.detectFromCwd()).not.toThrow();
  });
});
