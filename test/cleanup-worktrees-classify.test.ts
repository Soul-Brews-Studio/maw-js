import { describe, expect, test } from "bun:test";
import {
  cmdCleanupWorktrees,
  surveyCleanupWorktrees,
  type CleanupWorktreesDeps,
} from "../src/vendor/mpr-plugins/cleanup/internal/worktrees.ts?cleanup-worktrees-classify";

const reposRoot = "/repos/github.com";
const live = `${reposRoot}/org/repo/agents/1-live`;
const clean = `${reposRoot}/org/repo/agents/2-clean`;
const dirty = `${reposRoot}/org/repo/agents/3-dirty`;
const otherUser = `${reposRoot}/org/repo.wt-4-other`;

function deps(commands: string[] = []): CleanupWorktreesDeps {
  const paths = [live, clean, dirty, otherUser];
  return {
    getGhqRoot: () => "/repos",
    getUid: () => 501,
    statSync: ((path: string) => ({ uid: path === otherUser ? 999 : 501 })) as any,
    listPanes: async () => [{
      id: "%1",
      command: "codex",
      target: "team:live.0",
      title: "",
      cwd: `${live}/src`,
    }],
    hostExec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("find ")) return paths.join("\n");
      if (command.includes("rev-parse --abbrev-ref HEAD")) {
        if (command.includes("2-clean")) return "feature/clean\n";
        if (command.includes("3-dirty")) return "feature/dirty\n";
        return "feature/live\n";
      }
      if (command.includes("status --porcelain")) {
        return command.includes("3-dirty") ? " M changed.txt\n" : "";
      }
      if (command.includes("rev-parse --verify")) return "";
      if (command.includes("rev-list --count")) return "0\n";
      if (command.includes("worktree remove") || command.includes("worktree prune")) return "";
      throw new Error(`unexpected command: ${command}`);
    },
  };
}

describe("cleanup --worktrees survey", () => {
  test("classifies by pane cwd, git safety, and ownership", async () => {
    const rows = await surveyCleanupWorktrees({ deps: deps() });
    const byName = new Map(rows.map(row => [row.name, row]));

    expect(byName.get("1-live")?.classification).toBe("KEEP");
    expect(byName.get("1-live")?.livePane).toBe("team:live.0");
    expect(byName.get("2-clean")?.classification).toBe("CLEAN");
    expect(byName.get("3-dirty")?.classification).toBe("ASK");
    expect(byName.get("4-other")?.classification).toBe("SKIP");
  });

  test("--yes removes only CLEAN rows from the main repo", async () => {
    const commands: string[] = [];
    const rows = await cmdCleanupWorktrees({ yes: true, deps: deps(commands) });

    expect(rows.find(row => row.name === "2-clean")?.removed).toBe(true);
    expect(rows.filter(row => row.removed).map(row => row.name)).toEqual(["2-clean"]);
    expect(commands).toContain(`git -C '${reposRoot}/org/repo' worktree remove '${clean}' --force`);
    expect(commands).toContain(`git -C '${reposRoot}/org/repo' worktree prune`);
    expect(commands.join("\n")).not.toContain("3-dirty' --force");
  });
});
