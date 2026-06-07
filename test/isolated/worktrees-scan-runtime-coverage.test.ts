/**
 * Runtime coverage for scanWorktrees() IO/classification paths. The shell,
 * tmux, and pure matching policy are mocked so scanWorktrees owns only path
 * discovery, fleet config parsing, branch lookup, ambiguous diagnostics, and
 * orphan reconciliation in these tests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const fleetRoot = mkdtempSync(join(tmpdir(), "maw-worktrees-scan-fleet-"));
let ghqRoot = "/ghq";
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> | string = () => "";
let listSessionsImpl: () => Promise<unknown[]> | unknown[] = () => [];
let matchCalls: unknown[][] = [];
let errors: string[] = [];

const originalError = console.error;

mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return await hostExecImpl(cmd);
  },
  listSessions: async () => await listSessionsImpl(),
}));

mock.module(import.meta.resolve("../../src/config/ghq-root"), () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module(import.meta.resolve("../../src/core/paths"), () => ({
  FLEET_DIR: fleetRoot,
}));

mock.module(import.meta.resolve("../../src/core/xdg"), () => ({
  mawStatePath: () => fleetRoot,
}));

mock.module(import.meta.resolve("../../src/core/fleet/worktree-window-match"), () => ({
  resolveWorktreeWindow: (mainRepoName: string, wtName: string, sessions: unknown[]) => {
    matchCalls.push([mainRepoName, wtName, sessions]);
    if (wtName === "1-bound") return { kind: "bound", window: "bound-window" };
    if (wtName === "2-ambig") return { kind: "ambiguous", query: "ambig", candidates: ["tile-1", "6-tile-1"] };
    return { kind: "none" };
  },
}));

const { scanWorktrees } = await import("../../src/core/fleet/worktrees-scan.ts?worktrees-scan-runtime-coverage");

beforeEach(() => {
  ghqRoot = "/ghq";
  hostExecCalls = [];
  hostExecImpl = () => "";
  listSessionsImpl = () => [];
  matchCalls = [];
  errors = [];
  console.error = (line?: unknown) => { errors.push(String(line ?? "")); };
  rmSync(fleetRoot, { recursive: true, force: true });
  mkdirSync(fleetRoot, { recursive: true });
});

afterEach(() => {
  console.error = originalError;
});

afterAll(() => {
  rmSync(fleetRoot, { recursive: true, force: true });
});

const wt = (name: string) => `/ghq/github.com/Org/foo-oracle/foo-oracle.wt-${name}`;

describe("scanWorktrees runtime classification", () => {
  test("dedupes discovery paths, loads fleet files, classifies bound/ambiguous/none, and reconciles orphans", async () => {
    writeFileSync(join(fleetRoot, "workspace.json"), JSON.stringify({
      windows: [
        { repo: "Org/foo-oracle/foo-oracle.wt-1-bound" },
        { name: "ignored-no-repo" },
      ],
    }));
    writeFileSync(join(fleetRoot, "notes.txt"), "not json");

    const sessions = [{ name: "foo", windows: [{ name: "bound-window" }, { name: "tile-1" }] }];
    listSessionsImpl = () => sessions;
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("find ")) {
        return [
          wt("1-bound"),
          wt("1-bound"),
          wt("2-ambig"),
          wt("3-none"),
          "/ghq/github.com/Org/foo-oracle/not-a-worktree",
        ].join("\n");
      }
      if (cmd.includes("rev-parse --abbrev-ref")) {
        if (cmd.includes("2-ambig")) throw new Error("branch missing");
        return "feature/demo\n";
      }
      if (cmd.includes("worktree list --porcelain")) {
        return [wt("3-none"), wt("gone")].join("\n");
      }
      throw new Error(`unexpected command: ${cmd}`);
    };

    const results = await scanWorktrees();

    expect(hostExecCalls.filter((cmd) => cmd.startsWith("find "))).toHaveLength(1);
    expect(matchCalls).toEqual([
      ["foo-oracle", "1-bound", sessions],
      ["foo-oracle", "2-ambig", sessions],
      ["foo-oracle", "3-none", sessions],
    ]);

    expect(results).toEqual([
      {
        path: wt("1-bound"),
        branch: "feature/demo",
        repo: "Org/foo-oracle/foo-oracle.wt-1-bound",
        mainRepo: "Org/foo-oracle/foo-oracle",
        name: "1-bound",
        status: "active",
        tmuxWindow: "bound-window",
        fleetFile: "workspace.json",
      },
      {
        path: wt("2-ambig"),
        branch: "unknown",
        repo: "Org/foo-oracle/foo-oracle.wt-2-ambig",
        mainRepo: "Org/foo-oracle/foo-oracle",
        name: "2-ambig",
        status: "stale",
        tmuxWindow: undefined,
        fleetFile: undefined,
      },
      {
        path: wt("3-none"),
        branch: "feature/demo",
        repo: "Org/foo-oracle/foo-oracle.wt-3-none",
        mainRepo: "Org/foo-oracle/foo-oracle",
        name: "3-none",
        status: "orphan",
        tmuxWindow: undefined,
        fleetFile: undefined,
      },
      {
        path: wt("gone"),
        branch: "(prunable)",
        repo: "foo-oracle.wt-gone",
        mainRepo: "Org/foo-oracle/foo-oracle",
        name: "foo-oracle.wt-gone",
        status: "orphan",
      },
    ]);
    expect(errors.join("\n")).toContain("'ambig' is ambiguous");
    expect(errors.join("\n")).toContain("tile-1");
    expect(errors.join("\n")).toContain("leaving worktree 2-ambig unbound");
  });

  test("falls back to empty discovery when shell, tmux, and fleet IO fail", async () => {
    rmSync(fleetRoot, { recursive: true, force: true });
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("find ")) throw new Error("find unavailable");
      throw new Error(`unexpected command: ${cmd}`);
    };
    listSessionsImpl = () => { throw new Error("tmux unavailable"); };

    expect(await scanWorktrees()).toEqual([]);
    expect(hostExecCalls).toHaveLength(1);
    expect(matchCalls).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("ignores prunable lookup failures after classifying normal worktrees", async () => {
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("find ")) return wt("3-none");
      if (cmd.includes("rev-parse --abbrev-ref")) return "main";
      if (cmd.includes("worktree list --porcelain")) throw new Error("not a git repo");
      throw new Error(`unexpected command: ${cmd}`);
    };

    const results = await scanWorktrees();

    expect(results).toEqual([{
      path: wt("3-none"),
      branch: "main",
      repo: "Org/foo-oracle/foo-oracle.wt-3-none",
      mainRepo: "Org/foo-oracle/foo-oracle",
      name: "3-none",
      status: "stale",
      tmuxWindow: undefined,
      fleetFile: undefined,
    }]);
  });
});
