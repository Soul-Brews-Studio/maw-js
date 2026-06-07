import { describe, expect, test } from "bun:test";
import { join } from "path";
import { cmdDone, type DoneDeps } from "../../src/commands/shared/done";

const reposRoot = "/repos/github.com";
const main = `${reposRoot}/org/repo`;
const primary = `${main}/agents/1-codex`;
const other = `${reposRoot}/org/engine/agents/1-codex`;

function harness(hostExec: (command: string) => string | Promise<string>) {
  const logs: string[] = [];
  const commands: string[] = [];
  const files = new Map<string, string>([[
    "/fleet/team.json",
    JSON.stringify({ windows: [{ name: "mawjs-codex", repo: "org/repo/agents/1-codex" }] }),
  ]]);
  const deps: DoneDeps = {
    listSessions: async () => [],
    ghqRoot: "/repos",
    fleetDir: "/fleet",
    now: () => new Date("2026-06-06T01:02:03.004Z"),
    hostExec: async (command) => {
      commands.push(command);
      return await hostExec(command);
    },
    fs: {
      readdirSync: () => ["team.json"],
      readFileSync: (path: string) => files.get(path) ?? "{}",
      writeFileSync: (path: string, data: string) => files.set(path, data),
    },
    logger: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    },
    takeSnapshot: async () => undefined,
  };
  return { deps, logs, commands, files };
}

describe("maw done orphan worktree cleanup", () => {
  test("removes a clean configured orphan directory instead of reporting no worktree", async () => {
    const h = harness((command) => {
      if (command.includes("rev-parse --abbrev-ref")) throw new Error("not git");
      if (command.includes("worktree remove")) throw new Error(`fatal: '${primary}' is not a working tree`);
      if (command.startsWith("test -d")) return "";
      if (command.includes("status --porcelain")) return "";
      if (command.startsWith("rm -rf")) return "";
      if (command.includes("worktree prune")) return "";
      if (command.startsWith("find ")) return "";
      return "";
    });

    await cmdDone("mawjs-codex", { cwd: main }, h.deps);

    expect(h.logs.join("\n")).toContain("removed orphan directory 1-codex after verifying it was clean");
    expect(h.logs.join("\n")).not.toContain("no worktree to remove");
    expect(h.commands).toContain(`git -C '${primary}' status --porcelain --untracked-files=all`);
    expect(h.commands).toContain(`rm -rf '${primary}'`);
  });

  test("removes a clean worktree directory when git worktree remove leaves it behind (#2369)", async () => {
    const h = harness((command) => {
      if (command.includes("rev-parse --abbrev-ref")) return "feature/clean\n";
      if (command.includes("worktree remove")) throw new Error("fatal: Directory not empty");
      if (command.startsWith("test -d")) return "";
      if (command.includes("status --porcelain")) return "";
      if (command.startsWith("rm -rf")) return "";
      if (command.includes("worktree prune")) return "";
      if (command.startsWith("find ")) return "";
      return "";
    });

    await cmdDone("mawjs-codex", { cwd: main }, h.deps);

    expect(h.commands).toContain(`git -C '${primary}' status --porcelain --untracked-files=all`);
    expect(h.commands).toContain(`rm -rf '${primary}'`);
    expect(h.commands).toContain(`git -C '${main}' worktree prune`);
    expect(h.logs.join("\n")).toContain("removed orphan directory 1-codex after verifying it was clean");
  });

  test("refuses to remove a dirty orphan directory without force", async () => {
    const h = harness((command) => {
      if (command.includes("rev-parse --abbrev-ref")) return "feature\n";
      if (command.includes("worktree remove")) throw new Error("busy");
      if (command.startsWith("test -d")) return "";
      if (command.includes("status --porcelain")) return " M src/file.ts\n";
      if (command.startsWith("rm -rf")) throw new Error("dirty directory should not be removed");
      if (command.startsWith("find ")) return "";
      return "";
    });

    await expect(cmdDone("mawjs-codex", { cwd: main }, h.deps)).rejects.toThrow("has uncommitted changes");

    expect(h.commands).toContain(`git -C '${primary}' status --porcelain --untracked-files=all`);
    expect(h.commands.some(command => command.startsWith("rm -rf"))).toBe(false);
    expect(JSON.parse(h.files.get("/fleet/team.json")!).windows).toHaveLength(1);
  });

  test("force-removes a dirty orphan directory", async () => {
    const h = harness((command) => {
      if (command.includes("rev-parse --abbrev-ref")) return "feature\n";
      if (command.includes("worktree remove")) throw new Error("busy");
      if (command.startsWith("test -d")) return "";
      if (command.includes("status --porcelain")) return "?? scratch.txt\n";
      if (command.startsWith("rm -rf")) return "";
      if (command.includes("worktree prune")) return "";
      if (command.includes("merge-base --is-ancestor")) return "";
      if (command.startsWith("find ")) return "";
      return "";
    });

    await cmdDone("mawjs-codex", { force: true, cwd: main }, h.deps);

    expect(h.logs.join("\n")).toContain("removed orphan directory 1-codex with --force despite uncommitted changes");
    expect(h.commands).toContain(`rm -rf '${primary}'`);
    expect(JSON.parse(h.files.get("/fleet/team.json")!).windows).toEqual([]);
  });

  test("surfaces same-member worktrees that remain in other repos", async () => {
    const h = harness((command) => {
      if (command.includes("rev-parse --abbrev-ref")) return "main\n";
      if (command.includes("worktree remove") || command.includes("worktree prune")) return "";
      if (command.startsWith("find ")) return other;
      return "";
    });

    await cmdDone("mawjs-codex", { force: true, cwd: main }, h.deps);

    expect(h.logs.join("\n")).toContain("same-member worktree(s) still exist");
    expect(h.logs.join("\n")).toContain(other);
    expect(JSON.parse(h.files.get("/fleet/team.json")!).windows).toEqual([]);
  });
});
