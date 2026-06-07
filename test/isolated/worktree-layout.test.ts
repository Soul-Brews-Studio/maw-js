import { describe, expect, test } from "bun:test";
import {
  normalizeWorktreeLayout,
  parseWorktreePath,
  worktreeNameFromPath,
  worktreePathForLayout,
} from "../../src/core/fleet/worktree-layout";

describe("worktree layout helpers (#1850)", () => {
  test("default writer layout is nested repo/agents/<name>", () => {
    expect(worktreePathForLayout({
      repoPath: "/ghq/github.com/Org/repo-oracle",
      parentDir: "/ghq/github.com/Org",
      repoName: "repo-oracle",
      wtName: "1-feature",
    })).toBe("/ghq/github.com/Org/repo-oracle/agents/1-feature");
  });

  test("legacy writer layout remains explicit", () => {
    expect(worktreePathForLayout({
      repoPath: "/ghq/github.com/Org/repo-oracle",
      parentDir: "/ghq/github.com/Org",
      repoName: "repo-oracle",
      wtName: "1-feature",
      layout: "legacy",
    })).toBe("/ghq/github.com/Org/repo-oracle.wt-1-feature");
  });

  test("parses legacy and nested worktree paths", () => {
    const root = "/ghq/github.com";
    expect(parseWorktreePath("/ghq/github.com/Org/repo-oracle.wt-1-feature", root)).toMatchObject({
      layout: "legacy",
      mainRepoName: "repo-oracle",
      wtName: "1-feature",
      mainPath: "/ghq/github.com/Org/repo-oracle",
      mainRepo: "Org/repo-oracle",
      repo: "Org/repo-oracle.wt-1-feature",
    });
    expect(parseWorktreePath("/ghq/github.com/Org/repo-oracle/agents/1-feature", root)).toMatchObject({
      layout: "nested",
      dirName: "agents/1-feature",
      mainRepoName: "repo-oracle",
      wtName: "1-feature",
      mainPath: "/ghq/github.com/Org/repo-oracle",
      mainRepo: "Org/repo-oracle",
      repo: "Org/repo-oracle/agents/1-feature",
    });
  });

  test("normalizes CLI layout input", () => {
    expect(normalizeWorktreeLayout()).toBe("nested");
    expect(normalizeWorktreeLayout("legacy")).toBe("legacy");
    expect(() => normalizeWorktreeLayout("old")).toThrow("use 'nested' or 'legacy'");
  });

  test("extracts names from both path layouts", () => {
    expect(worktreeNameFromPath("/tmp/repo.wt-2-task")).toBe("2-task");
    expect(worktreeNameFromPath("/tmp/repo/agents/2-task")).toBe("2-task");
  });
});
