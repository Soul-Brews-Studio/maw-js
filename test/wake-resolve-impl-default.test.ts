import { describe, expect, it } from "bun:test";
import {
  resolveFromWorktrees,
  resolveLocalOracleRepoName,
  sanitizeBranchName,
} from "../src/commands/shared/wake-resolve-impl";
import type { WorktreeInfo } from "../src/core/fleet/worktrees-scan";

// Default coverage command only collects test/*.test.ts. Keep these tests free
// of Bun module mocks: the colocated resolver suite mocks sdk/config globally,
// which can pollute unrelated default-run suites when CI test ordering changes.

describe("sanitizeBranchName (#823 Bug A) — default coverage", () => {
  it("strips all leading and trailing dash/dot runs", () => {
    expect(sanitizeBranchName("--no-attach")).toBe("no-attach");
    expect(sanitizeBranchName("foo--")).toBe("foo");
    expect(sanitizeBranchName("foo..")).toBe("foo");
    expect(sanitizeBranchName("--foo--")).toBe("foo");
  });

  it("collapses pure-junk input to empty string", () => {
    expect(sanitizeBranchName("--")).toBe("");
    expect(sanitizeBranchName("...")).toBe("");
  });

  it("normalizes case, whitespace, punctuation, duplicate dots, and length", () => {
    expect(sanitizeBranchName("My Task Name")).toBe("my-task-name");
    expect(sanitizeBranchName("Hello!  Weird@@Name")).toBe("hello-weirdname");
    expect(sanitizeBranchName("a..b...c")).toBe("a.b.c");
    expect(sanitizeBranchName("x".repeat(80))).toHaveLength(50);
  });
});

describe("resolveLocalOracleRepoName (#1469/#1635) — default coverage", () => {
  const repos = [
    "github.com/Soul-Brews-Studio/mawjs-oracle",
    "github.com/Soul-Brews-Studio/mawjs-codex-oracle",
    "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
    "github.com/Soul-Brews-Studio/not-an-oracle",
  ];

  it("prefers exact full and bare oracle names before fuzzy suffixes", () => {
    expect(resolveLocalOracleRepoName("mawjs-codex-oracle", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
    expect(resolveLocalOracleRepoName("mawjs-codex", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  it("strips a numeric fleet prefix before exact local oracle lookup", () => {
    expect(resolveLocalOracleRepoName("48-mawjs-codex", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  it("keeps legacy fuzzy lookup for non-exact abbreviations", () => {
    expect(resolveLocalOracleRepoName("v3", repos)).toEqual({
      kind: "fuzzy",
      match: "arra-oracle-v3-oracle",
    });
  });

  it("fails loudly when a bare oracle name exists in multiple orgs (#1635)", () => {
    expect(resolveLocalOracleRepoName("pulse", [
      "github.com/laris-co/pulse-oracle",
      "github.com/Soul-Brews-Studio/pulse-oracle",
    ])).toEqual({
      kind: "ambiguous",
      candidates: [
        "laris-co/pulse-oracle",
        "Soul-Brews-Studio/pulse-oracle",
      ],
    });
  });

  it("returns none for empty or missing local oracle targets", () => {
    expect(resolveLocalOracleRepoName("", repos)).toEqual({ kind: "none" });
    expect(resolveLocalOracleRepoName("missing", repos)).toEqual({ kind: "none" });
  });
});

describe("resolveFromWorktrees — injected default coverage", () => {
  const worktree = (path: string, mainRepo: string): WorktreeInfo => ({
    path,
    mainRepo,
    branch: "feature/test",
    wtName: path.split("/").pop() ?? "worktree",
    isCurrent: false,
  });

  it("returns null when no worktree main repo matches the oracle", async () => {
    const result = await resolveFromWorktrees(
      "mawjs",
      async () => [worktree("/tmp/other.wt-1", "github.com/Org/other-oracle")],
      async () => "/tmp/mawjs-oracle/.git",
      () => true,
    );
    expect(result).toBeNull();
  });

  it("returns null when git common-dir lookup is empty", async () => {
    const result = await resolveFromWorktrees(
      "mawjs",
      async () => [worktree("/tmp/mawjs-oracle.wt-1", "github.com/Org/mawjs-oracle")],
      async () => "\n",
      () => true,
    );
    expect(result).toBeNull();
  });

  it("resolves a main repo path from a linked-worktree .git common-dir", async () => {
    const commands: string[] = [];
    const result = await resolveFromWorktrees(
      "mawjs",
      async () => [worktree("/tmp/mawjs-oracle.wt-1", "github.com/Org/mawjs-oracle")],
      async cmd => {
        commands.push(cmd);
        return "/repos/Soul-Brews-Studio/mawjs-oracle/.git\n";
      },
      path => path === "/repos/Soul-Brews-Studio/mawjs-oracle",
    );

    expect(commands[0]).toContain("git -C '/tmp/mawjs-oracle.wt-1' rev-parse --git-common-dir");
    expect(result).toEqual({
      repoPath: "/repos/Soul-Brews-Studio/mawjs-oracle",
      repoName: "mawjs-oracle",
      parentDir: "/repos/Soul-Brews-Studio",
    });
  });

  it("accepts a common-dir that is already the main repo path", async () => {
    const result = await resolveFromWorktrees(
      "mawjs",
      async () => [worktree("/tmp/mawjs-oracle.wt-2", "github.com/Org/mawjs-oracle")],
      async () => "/repos/mawjs-oracle\n",
      path => path === "/repos/mawjs-oracle",
    );

    expect(result).toEqual({
      repoPath: "/repos/mawjs-oracle",
      repoName: "mawjs-oracle",
      parentDir: "/repos",
    });
  });

  it("returns null when the resolved main repo path is missing", async () => {
    const result = await resolveFromWorktrees(
      "mawjs",
      async () => [worktree("/tmp/mawjs-oracle.wt-3", "github.com/Org/mawjs-oracle")],
      async () => "/missing/mawjs-oracle/.git\n",
      () => false,
    );

    expect(result).toBeNull();
  });
});
