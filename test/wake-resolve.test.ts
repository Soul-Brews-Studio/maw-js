/**
 * Tests for resolveFromWorktrees — the worktree fallback in resolveOracle.
 *
 * When ghq doesn't know about an oracle (e.g. on a machine where ghq isn't
 * configured or the ghq root was moved), but `maw ls` can see a worktree for
 * it, `maw wake` should still work. Nat's insight: "if we have a worktree we
 * have a git repo for sure."
 *
 * We test resolveFromWorktrees directly with injected deps (no module mocking)
 * following the same pattern as wake.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { resolveFromWorktrees, matchOracleWindow } from "../src/commands/shared/wake-resolve-impl";
import type { WorktreeInfo } from "../src/core/fleet/worktrees-scan";

const MAIN_PATH = "/home/user/ghq/github.com/Soul-Brews-Studio/wireboy-oracle";
const GIT_COMMON = `${MAIN_PATH}/.git`;

const orphanWorktree: WorktreeInfo = {
  path: `${MAIN_PATH}.wt-1-jera-pagination-srakaew`,
  branch: "(prunable)",
  repo: "github.com/Soul-Brews-Studio/wireboy-oracle.wt-1-jera-pagination-srakaew",
  mainRepo: "github.com/Soul-Brews-Studio/wireboy-oracle",
  name: "1-jera-pagination-srakaew",
  status: "orphan",
};

const execGitCommon = async (cmd: string) => {
  if (cmd.includes("rev-parse --git-common-dir")) return GIT_COMMON;
  return "";
};

describe("resolveFromWorktrees — worktree fallback", () => {
  test("resolves oracle when worktree exists and main repo is on disk", async () => {
    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [orphanWorktree],
      execGitCommon,
      (p) => p === MAIN_PATH,
    );

    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe(MAIN_PATH);
    expect(result!.repoName).toBe("wireboy-oracle");
    expect(result!.parentDir).toBe("/home/user/ghq/github.com/Soul-Brews-Studio");
  });

  test("returns null when no worktree matches the oracle name", async () => {
    const result = await resolveFromWorktrees(
      "notexist",
      async () => [orphanWorktree],
      execGitCommon,
      () => true,
    );
    expect(result).toBeNull();
  });

  test("returns null when main repo has been deleted from disk", async () => {
    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [orphanWorktree],
      execGitCommon,
      () => false, // existsFn always false — repo deleted
    );
    expect(result).toBeNull();
  });

  test("returns null when git rev-parse returns empty (corrupt worktree)", async () => {
    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [orphanWorktree],
      async () => "", // empty git output
      () => true,
    );
    expect(result).toBeNull();
  });

  test("handles active worktree (not just orphan) equally", async () => {
    const active: WorktreeInfo = {
      ...orphanWorktree,
      status: "active",
      tmuxWindow: "wireboy-oracle",
    };
    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [active],
      execGitCommon,
      (p) => p === MAIN_PATH,
    );
    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe(MAIN_PATH);
  });

  test("picks the correct oracle when multiple worktrees are present", async () => {
    const otherWorktree: WorktreeInfo = {
      path: "/home/user/ghq/github.com/Soul-Brews-Studio/neo-oracle.wt-1-feature",
      branch: "main",
      repo: "github.com/Soul-Brews-Studio/neo-oracle.wt-1-feature",
      mainRepo: "github.com/Soul-Brews-Studio/neo-oracle",
      name: "1-feature",
      status: "stale",
    };

    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [otherWorktree, orphanWorktree],
      async (cmd) => {
        // Only wireboy worktree should be queried
        if (cmd.includes(orphanWorktree.path) && cmd.includes("rev-parse --git-common-dir")) {
          return GIT_COMMON;
        }
        return "";
      },
      (p) => p === MAIN_PATH,
    );

    expect(result).not.toBeNull();
    expect(result!.repoName).toBe("wireboy-oracle");
  });

  test("returns null for empty worktree list", async () => {
    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [],
      execGitCommon,
      () => true,
    );
    expect(result).toBeNull();
  });
});

/**
 * Tests for matchOracleWindow — fleet window name comparator that tolerates
 * the `^\d+-` tmux session prefix that callers like `maw a <oracle>` carry in.
 *
 * #1282 — oracle="20-homekeeper" must match window.name="homekeeper-oracle".
 * Without the strip, every `maw a` invocation from a numbered fleet session
 * silently fell through fleet-pin lookup into fleet-clone.
 */
describe("matchOracleWindow — #1282 numeric prefix strip", () => {
  test("strips numeric prefix: oracle='20-homekeeper' matches 'homekeeper-oracle'", () => {
    expect(matchOracleWindow("20-homekeeper", "homekeeper-oracle")).toBe(true);
  });

  test("strips numeric prefix: oracle='20-homekeeper' matches bare 'homekeeper'", () => {
    expect(matchOracleWindow("20-homekeeper", "homekeeper")).toBe(true);
  });

  test("backward compat: oracle='homekeeper' still matches 'homekeeper-oracle'", () => {
    expect(matchOracleWindow("homekeeper", "homekeeper-oracle")).toBe(true);
  });

  test("backward compat: oracle='mawjs' matches 'mawjs-oracle'", () => {
    expect(matchOracleWindow("mawjs", "mawjs-oracle")).toBe(true);
  });

  test("backward compat: oracle='mawjs' matches bare 'mawjs'", () => {
    expect(matchOracleWindow("mawjs", "mawjs")).toBe(true);
  });

  test("preserves prefixed form too: oracle='20-homekeeper' matches '20-homekeeper-oracle'", () => {
    // Some configs may genuinely name a window with the numeric prefix — don't lose that path.
    expect(matchOracleWindow("20-homekeeper", "20-homekeeper-oracle")).toBe(true);
  });

  test("multi-digit prefix: oracle='110-yeast' matches 'yeast-oracle'", () => {
    expect(matchOracleWindow("110-yeast", "yeast-oracle")).toBe(true);
  });

  test("non-numeric prefix is NOT stripped: oracle='dev-homekeeper' does not match 'homekeeper-oracle'", () => {
    expect(matchOracleWindow("dev-homekeeper", "homekeeper-oracle")).toBe(false);
  });

  test("mismatched name returns false: oracle='20-homekeeper' does not match 'wireboy-oracle'", () => {
    expect(matchOracleWindow("20-homekeeper", "wireboy-oracle")).toBe(false);
  });

  test("empty window name returns false", () => {
    expect(matchOracleWindow("homekeeper", "")).toBe(false);
  });
});
