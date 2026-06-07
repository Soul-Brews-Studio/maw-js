/**
 * Default-suite coverage for scanWorktrees().
 *
 * The deeper regression suite lives in test/isolated because it historically
 * used mock.module(). These seam tests use injected dependencies instead so the
 * core fleet scanner contributes to LCOV without polluting the shared suite.
 */
import { describe, expect, test } from "bun:test";
import { basename, join } from "path";
import { scanWorktrees, type ScanWorktreesDeps } from "../src/core/fleet/worktrees-scan";
import type { Session, Window } from "../src/core/runtime/find-window";

const reposRoot = "/ghq/github.com";

function wtPath(org: string, oracle: string, wt: string): string {
  return `${reposRoot}/${org}/${oracle}/${oracle}.wt-${wt}`;
}

function derived(path: string) {
  const dirName = path.split("/").pop()!;
  const mainRepoName = dirName.split(".wt-")[0]!;
  const relPath = path.replace(`${reposRoot}/`, "");
  const parentParts = relPath.split("/");
  parentParts.pop();
  const org = parentParts.join("/");
  const mainRepo = `${org}/${mainRepoName}`;
  return {
    dirName,
    repo: `${org}/${dirName}`,
    mainRepo,
    mainPath: join(reposRoot, mainRepo),
  };
}

function win(name: string): Window {
  return { name, index: 1, active: false };
}

function session(name: string, windows: Window[]): Session {
  return { name, windows };
}

function makeDeps(opts: {
  findPaths?: string[];
  findThrows?: boolean;
  sessions?: Session[];
  sessionsThrow?: boolean;
  branches?: Record<string, string | Error>;
  fleet?: Record<string, unknown>;
  fleetThrows?: boolean;
  prunable?: Record<string, string>;
  errors?: string[];
  commands?: string[];
} = {}): ScanWorktreesDeps {
  const errors = opts.errors ?? [];
  const commands = opts.commands ?? [];
  return {
    getGhqRoot: () => "/ghq",
    fleetDir: "/fleet",
    listSessions: async () => {
      if (opts.sessionsThrow) throw new Error("tmux unavailable");
      return opts.sessions ?? [];
    },
    readdirSync: () => {
      if (opts.fleetThrows) throw new Error("fleet unavailable");
      return Object.keys(opts.fleet ?? {});
    },
    readFileSync: (path) => {
      const value = opts.fleet?.[basename(path)];
      if (value instanceof Error) throw value;
      return typeof value === "string" ? value : JSON.stringify(value ?? {});
    },
    hostExec: async (cmd) => {
      commands.push(cmd);
      if (cmd.startsWith(`find ${reposRoot} `)) {
        if (opts.findThrows) throw new Error("find failed");
        return (opts.findPaths ?? []).join("\n");
      }

      const gitPath = cmd.match(/git -C '([^']+)'/)?.[1] ?? "";
      if (cmd.includes("rev-parse --abbrev-ref")) {
        const branch = opts.branches?.[gitPath] ?? "main";
        if (branch instanceof Error) throw branch;
        return branch;
      }
      if (cmd.includes("worktree list --porcelain")) {
        return opts.prunable?.[gitPath] ?? "";
      }
      return "";
    },
    error: (...args) => errors.push(args.map(String).join(" ")),
  };
}

describe("scanWorktrees default-suite coverage", () => {
  test("dedupes find paths, binds running windows, attaches fleet metadata, and marks existing prunable paths", async () => {
    const activePath = wtPath("Org", "mawjs-oracle", "6-tile-1");
    const prunablePath = wtPath("Org", "ghost-oracle", "1-later");
    const active = derived(activePath);
    const prunable = derived(prunablePath);
    const commands: string[] = [];

    const results = await scanWorktrees(makeDeps({
      findPaths: [activePath, activePath, prunablePath, "/ghq/github.com/Org/not-a-worktree"],
      sessions: [session("54-mawjs", [win("mawjs-6-tile-1")])],
      branches: {
        [activePath]: "feature/tile",
        [prunablePath]: "feature/ghost",
      },
      fleet: {
        "01-mawjs.json": { windows: [{ repo: active.repo }] },
      },
      prunable: {
        [prunable.mainPath]: prunablePath,
      },
      commands,
    }));

    expect(results.filter((r) => r.path === activePath)).toHaveLength(1);
    expect(results.find((r) => r.path === activePath)).toMatchObject({
      branch: "feature/tile",
      repo: active.repo,
      mainRepo: active.mainRepo,
      name: "6-tile-1",
      status: "active",
      tmuxWindow: "mawjs-6-tile-1",
      fleetFile: "01-mawjs.json",
    });
    expect(results.find((r) => r.path === prunablePath)).toMatchObject({
      branch: "feature/ghost",
      status: "orphan",
    });
    expect(commands.filter((cmd) => cmd.includes("rev-parse --abbrev-ref"))).toHaveLength(2);
  });

  test("falls back cleanly for tmux, branch, and fleet failures while adding unseen prunable worktrees", async () => {
    const stalePath = wtPath("Org", "stale-oracle", "1-task");
    const stale = derived(stalePath);
    const unseenOrphan = "/ghq/github.com/Org/stale-oracle/stale-oracle.wt-pruned";

    const results = await scanWorktrees(makeDeps({
      findPaths: [stalePath],
      sessionsThrow: true,
      branches: { [stalePath]: new Error("branch failed") },
      fleetThrows: true,
      prunable: { [stale.mainPath]: unseenOrphan },
    }));

    expect(results.find((r) => r.path === stalePath)).toMatchObject({
      branch: "unknown",
      status: "stale",
      tmuxWindow: undefined,
      fleetFile: undefined,
    });
    expect(results.find((r) => r.path === unseenOrphan)).toMatchObject({
      branch: "(prunable)",
      repo: "stale-oracle.wt-pruned",
      mainRepo: stale.mainRepo,
      name: "stale-oracle.wt-pruned",
      status: "orphan",
    });
  });

  test("logs ambiguous window matches and leaves the worktree stale", async () => {
    const path = wtPath("Org", "shared-oracle", "1-tile");
    const errors: string[] = [];

    const results = await scanWorktrees(makeDeps({
      findPaths: [path],
      sessions: [
        session("alpha", [win("alpha-tile")]),
        session("beta", [win("beta-tile")]),
      ],
      errors,
    }));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path, status: "stale", tmuxWindow: undefined });
    expect(errors.join("\n")).toContain("'tile' is ambiguous");
    expect(errors.join("\n")).toContain("alpha-tile");
    expect(errors.join("\n")).toContain("beta-tile");
  });

  test("loads fleet metadata from XDG state dirs before legacy fleet dirs", async () => {
    const path = wtPath("Org", "state-oracle", "1-xdg");
    const info = derived(path);

    const deps = makeDeps({
      findPaths: [path],
    });
    deps.fleetDirs = ["/state/fleet", "/legacy/fleet"];
    deps.readdirSync = (dir) => {
      if (dir === "/state/fleet") return ["01-state.json"];
      if (dir === "/legacy/fleet") return ["01-state.json", "99-legacy.json"];
      return [];
    };
    deps.readFileSync = (filePath) => {
      if (filePath === "/state/fleet/01-state.json") {
        return JSON.stringify({ windows: [{ repo: info.repo }] });
      }
      if (filePath === "/legacy/fleet/01-state.json") {
        throw new Error("duplicate legacy file should be skipped");
      }
      if (filePath === "/legacy/fleet/99-legacy.json") {
        return JSON.stringify({ windows: [{ repo: info.repo }] });
      }
      return "{}";
    };

    const results = await scanWorktrees(deps);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path,
      repo: info.repo,
      fleetFile: "01-state.json",
    });
  });

  test("returns an empty list when the worktree discovery command fails", async () => {
    await expect(scanWorktrees(makeDeps({ findThrows: true }))).resolves.toEqual([]);
  });
});
