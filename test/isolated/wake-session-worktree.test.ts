/**
 * Worktree creation tests — ISOLATED SUITE.
 *
 * Why isolated: createWorktree shells through @maw-js/sdk/hostExec.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let commands: string[] = [];
let existingBranches = new Set<string>();

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("rev-parse HEAD")) return "abc123\n";
    const branchMatch = cmd.match(/show-ref --verify --quiet 'refs\/heads\/([^']+)'/);
    if (branchMatch) {
      if (existingBranches.has(branchMatch[1])) return "";
      throw new Error("missing ref");
    }
    return "";
  },
  tmux: {},
}));

const { createWorktree } = await import("../../src/commands/shared/wake-session");

beforeEach(() => {
  commands = [];
  existingBranches = new Set<string>();
});

describe("createWorktree", () => {
  test("creates the next worktree branch without deleting existing branches", async () => {
    await createWorktree("/repo", "/tmp", "repo", "oracle", "tile-1", []);

    expect(commands.some(cmd => cmd.includes("branch -D"))).toBe(false);
    expect(commands).toContain("git -C '/repo' worktree add '/tmp/repo.wt-1-tile-1' -b 'agents/1-tile-1'");
  });

  test("reattaches an existing stale branch at the stable reusable slot", async () => {
    existingBranches.add("agents/1-tile-1");

    await createWorktree("/repo", "/tmp", "repo", "oracle", "tile-1", []);

    expect(commands.some(cmd => cmd.includes("branch -D"))).toBe(false);
    expect(commands).toContain("git -C '/repo' show-ref --verify --quiet 'refs/heads/agents/1-tile-1'");
    expect(commands).toContain("git -C '/repo' worktree add '/tmp/repo.wt-1-tile-1' 'agents/1-tile-1'");
  });

  test("fresh mode skips stale branch names instead of clobbering them", async () => {
    existingBranches.add("agents/1-tile-1");

    await createWorktree("/repo", "/tmp", "repo", "oracle", "tile-1", [], { fresh: true });

    expect(commands.some(cmd => cmd.includes("branch -D"))).toBe(false);
    expect(commands).toContain("git -C '/repo' show-ref --verify --quiet 'refs/heads/agents/1-tile-1'");
    expect(commands).toContain("git -C '/repo' worktree add '/tmp/repo.wt-2-tile-1' -b 'agents/2-tile-1'");
  });
});
