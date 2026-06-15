import { describe, it, expect } from "bun:test";
import { stripOracleRepoSuffix, bringCwdMetadata, deriveOracleFromCwd } from "./wake-cwd";

/**
 * #2569 — zero-arg `maw wake` cwd → oracle derivation. Pure helpers, no mocks.
 */

describe("stripOracleRepoSuffix", () => {
  it("strips a trailing -oracle (case-insensitive, preserves case)", () => {
    expect(stripOracleRepoSuffix("mawjs-codex-oracle")).toBe("mawjs-codex");
    expect(stripOracleRepoSuffix("Discord-Oracle")).toBe("Discord");
  });
  it("returns null when there is no -oracle suffix", () => {
    expect(stripOracleRepoSuffix("maw-js")).toBeNull();
    expect(stripOracleRepoSuffix("oracle")).toBeNull();
  });
});

describe("bringCwdMetadata", () => {
  it("derives oracle from a plain <name>-oracle repo dir", () => {
    expect(bringCwdMetadata("/opt/Code/github.com/Soul-Brews-Studio/mawjs-codex-oracle"))
      .toEqual({ oracle: "mawjs-codex" });
  });
  it("derives oracle + worktree from the nested agents/ layout", () => {
    expect(bringCwdMetadata("/o/mawjs-oracle/agents/1-fix-2550"))
      .toEqual({ oracle: "mawjs", worktree: "1-fix-2550" });
  });
  it("derives oracle + worktree from the legacy .wt- layout", () => {
    expect(bringCwdMetadata("/o/mawjs-oracle.wt-2-white"))
      .toEqual({ oracle: "mawjs", worktree: "2-white" });
  });
  it("returns {} for a non-oracle dir or empty path", () => {
    expect(bringCwdMetadata("/opt/Code/github.com/Soul-Brews-Studio/maw-js")).toEqual({});
    expect(bringCwdMetadata("")).toEqual({});
    expect(bringCwdMetadata(undefined)).toEqual({});
  });
});

describe("deriveOracleFromCwd (#2569)", () => {
  it("resolves the maw-js source repo (no -oracle suffix) via the basename fallback", () => {
    // The exact case from the issue: cwd is the maw-js checkout.
    expect(deriveOracleFromCwd("/opt/Code/github.com/Soul-Brews-Studio/maw-js")).toBe("maw-js");
  });

  it("resolves a standard <name>-oracle repo to its stem", () => {
    expect(deriveOracleFromCwd("/opt/Code/github.com/Soul-Brews-Studio/mawjs-codex-oracle")).toBe("mawjs-codex");
  });

  it("resolves from inside a nested-layout worktree", () => {
    expect(deriveOracleFromCwd("/opt/Code/github.com/Soul-Brews-Studio/mawjs-codex-oracle/agents/1-fix-2550"))
      .toBe("mawjs-codex");
  });

  it("resolves from inside a legacy .wt- worktree", () => {
    expect(deriveOracleFromCwd("/opt/Code/github.com/laris-co/mawjs-oracle.wt-2-white")).toBe("mawjs");
  });

  it("falls back to the basename for a non-oracle repo cwd", () => {
    expect(deriveOracleFromCwd("/opt/Code/github.com/acme/some-tool")).toBe("some-tool");
  });

  it("returns undefined for root / empty / undefined (cmdWake then surfaces a usage error)", () => {
    expect(deriveOracleFromCwd("/")).toBeUndefined();
    expect(deriveOracleFromCwd("")).toBeUndefined();
    expect(deriveOracleFromCwd(undefined)).toBeUndefined();
  });
});
