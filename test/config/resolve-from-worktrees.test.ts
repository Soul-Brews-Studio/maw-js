/**
 * Tests for resolveFromWorktrees from src/commands/shared/wake-resolve-impl.ts — DI injectable.
 */
import { describe, it, expect } from "bun:test";
import { resolveFromWorktrees } from "../../src/commands/shared/wake-resolve-impl";
import type { WorktreeInfo } from "../../src/core/fleet/worktrees-scan";

function mkWorktree(path: string, mainRepo: string): WorktreeInfo {
  return { path, mainRepo, branch: "main", head: "abc123" } as WorktreeInfo;
}

describe("resolveFromWorktrees", () => {
  it("returns null when no worktrees match", async () => {
    const result = await resolveFromWorktrees(
      "spark",
      async () => [mkWorktree("/tmp/wt", "github.com/org/other-oracle")],
      async () => "",
      () => false,
    );
    expect(result).toBeNull();
  });

  it("returns null when scanFn returns empty", async () => {
    const result = await resolveFromWorktrees(
      "spark",
      async () => [],
      async () => "",
      () => false,
    );
    expect(result).toBeNull();
  });

  it("returns null when git common dir is empty", async () => {
    const result = await resolveFromWorktrees(
      "spark",
      async () => [mkWorktree("/tmp/wt", "github.com/org/spark-oracle")],
      async () => "",
      () => true,
    );
    expect(result).toBeNull();
  });

  it("resolves when worktree matches oracle-oracle pattern", async () => {
    const result = await resolveFromWorktrees(
      "spark",
      async () => [mkWorktree("/tmp/wt", "github.com/org/spark-oracle")],
      async () => "/home/user/ghq/github.com/org/spark-oracle/.git\n",
      (p) => p === "/home/user/ghq/github.com/org/spark-oracle",
    );
    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe("/home/user/ghq/github.com/org/spark-oracle");
    expect(result!.repoName).toBe("spark-oracle");
  });

  it("returns null when main repo path does not exist", async () => {
    const result = await resolveFromWorktrees(
      "spark",
      async () => [mkWorktree("/tmp/wt", "github.com/org/spark-oracle")],
      async () => "/home/user/ghq/github.com/org/spark-oracle/.git",
      () => false,
    );
    expect(result).toBeNull();
  });

  it("strips /.git suffix from common dir", async () => {
    const result = await resolveFromWorktrees(
      "forge",
      async () => [mkWorktree("/tmp/wt", "github.com/org/forge-oracle")],
      async () => "/repos/forge-oracle/.git",
      (p) => p === "/repos/forge-oracle",
    );
    expect(result!.repoPath).toBe("/repos/forge-oracle");
  });

  it("handles git common dir without .git suffix", async () => {
    const result = await resolveFromWorktrees(
      "forge",
      async () => [mkWorktree("/tmp/wt", "github.com/org/forge-oracle")],
      async () => "/repos/forge-oracle",
      (p) => p === "/repos/forge-oracle",
    );
    expect(result!.repoPath).toBe("/repos/forge-oracle");
  });

  it("extracts parentDir correctly", async () => {
    const result = await resolveFromWorktrees(
      "ember",
      async () => [mkWorktree("/tmp/wt", "github.com/org/ember-oracle")],
      async () => "/a/b/ember-oracle/.git",
      (p) => p === "/a/b/ember-oracle",
    );
    expect(result!.parentDir).toBe("/a/b");
  });
});
