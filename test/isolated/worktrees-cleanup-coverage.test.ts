/**
 * Isolated coverage for cleanupWorktree().
 *
 * The module owns tmux-window resolution, git cleanup command sequencing,
 * branch-deletion safety, and fleet JSON rewrites. External tmux/ssh/config
 * seams are mocked so no real worktrees, branches, tmux windows, or fleet
 * configs are touched.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockSshModule } from "../helpers/mock-ssh";

type Session = { name: string; windows: Array<{ name: string; index?: number; active?: boolean }> };

const fleetRoot = mkdtempSync(join(tmpdir(), "maw-worktrees-cleanup-fleet-"));
const stateFleetRoot = mkdtempSync(join(tmpdir(), "maw-worktrees-cleanup-state-fleet-"));

type FleetEntry = {
  file: string;
  path?: string;
  num: number;
  groupName: string;
  session: { name?: string; windows?: Array<{ name: string; repo: string }> };
};

let ghqRoot = "/ghq";
let commands: string[] = [];
let sessions: Session[] = [];
let killedTargets: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> | string = () => "";
let killWindowImpl: (target: string) => Promise<void> | void = () => {};
let fleetEntries: FleetEntry[] = [];
let loadFleetEntriesImpl: () => FleetEntry[] = () => fleetEntries;

mock.module(import.meta.resolve("../../src/core/transport/ssh"), () =>
  mockSshModule({
    hostExec: async (cmd: string) => {
      commands.push(cmd);
      return await hostExecImpl(cmd);
    },
    listSessions: async () => sessions,
  }),
);

mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmux: {
    killWindow: async (target: string) => {
      killedTargets.push(target);
      await killWindowImpl(target);
    },
  },
}));

mock.module(import.meta.resolve("../../src/config/ghq-root"), () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => loadFleetEntriesImpl(),
}));

const { cleanupWorktree } = await import("../../src/core/fleet/worktrees-cleanup.ts?worktrees-cleanup-coverage");

const worktreePath = (repo = "maw-js", wt = "1-tile-1", org = "Soul-Brews-Studio") =>
  `/ghq/github.com/${org}/${repo}.wt-${wt}`;

function addFleetEntry(file: string, session: FleetEntry["session"], dir = fleetRoot) {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(session, null, 2));
  fleetEntries.push({
    file,
    path,
    num: Number(file.match(/^(\d+)-/)?.[1] ?? 0),
    groupName: file.replace(/^\d+-/, "").replace(/\.json$/, ""),
    session,
  });
  return path;
}

beforeEach(() => {
  ghqRoot = "/ghq";
  commands = [];
  sessions = [];
  killedTargets = [];
  hostExecImpl = () => "";
  killWindowImpl = () => {};
  fleetEntries = [];
  loadFleetEntriesImpl = () => fleetEntries;
  rmSync(fleetRoot, { recursive: true, force: true });
  rmSync(stateFleetRoot, { recursive: true, force: true });
  mkdirSync(fleetRoot, { recursive: true });
  mkdirSync(stateFleetRoot, { recursive: true });
});

afterAll(() => {
  rmSync(fleetRoot, { recursive: true, force: true });
  rmSync(stateFleetRoot, { recursive: true, force: true });
});

describe("cleanupWorktree coverage", () => {
  test("rejects paths whose basename is not a .wt worktree without side effects", async () => {
    const log = await cleanupWorktree("/ghq/github.com/Soul-Brews-Studio/maw-js");

    expect(log).toEqual(["not a worktree: maw-js"]);
    expect(commands).toEqual([]);
    expect(killedTargets).toEqual([]);
  });

  test("exact window match kills tmux, removes/prunes worktree, deletes branch, and rewrites fleet config", async () => {
    addFleetEntry("team.json", {
      windows: [
        { name: "tile-1", repo: "Soul-Brews-Studio/maw-js.wt-1-tile-1" },
        { name: "lead", repo: "Soul-Brews-Studio/maw-js" },
      ],
    });
    writeFileSync(join(fleetRoot, "notes.txt"), "ignored");

    sessions = [{ name: "work", windows: [{ name: "tile-1" }, { name: "lead" }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature/cleanup\n";
      if (cmd.includes("worktree remove") || cmd.includes("worktree prune") || cmd.includes("branch -d")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const log = await cleanupWorktree(worktreePath());

    expect(killedTargets).toEqual(["work:tile-1"]);
    expect(commands).toEqual([
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-1-tile-1' rev-parse --abbrev-ref HEAD",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree remove '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-1-tile-1' --force",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree prune",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' branch -d 'feature/cleanup'",
    ]);
    expect(log).toEqual([
      "killed window work:tile-1",
      "removed worktree maw-js.wt-1-tile-1",
      "deleted branch feature/cleanup",
      "removed from team.json",
    ]);
    expect(JSON.parse(readFileSync(join(fleetRoot, "team.json"), "utf-8"))).toEqual({
      windows: [{ name: "lead", repo: "Soul-Brews-Studio/maw-js" }],
    });
  });

  test("writes fleet cleanup back to the source XDG state path", async () => {
    const statePath = addFleetEntry("01-maw.json", {
      name: "01-maw",
      windows: [
        { name: "tile-1", repo: "Soul-Brews-Studio/maw-js.wt-1-tile-1" },
        { name: "lead", repo: "Soul-Brews-Studio/maw-js" },
      ],
    }, stateFleetRoot);

    sessions = [];
    hostExecImpl = (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature/cleanup\n";
      if (cmd.includes("worktree remove") || cmd.includes("worktree prune") || cmd.includes("branch -d")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const log = await cleanupWorktree(worktreePath());

    expect(log).toContain("removed from 01-maw.json");
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({
      name: "01-maw",
      windows: [{ name: "lead", repo: "Soul-Brews-Studio/maw-js" }],
    });
  });

  test("ambiguous window matches are not killed; protected branches and remove failures are reported safely", async () => {
    loadFleetEntriesImpl = () => { throw new Error("bad json"); };
    sessions = [
      { name: "neo", windows: [{ name: "neo-tile-1" }] },
      { name: "pulse", windows: [{ name: "pulse-tile-1" }] },
    ];
    hostExecImpl = (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("worktree remove")) throw new Error("busy");
      throw new Error(`unexpected command: ${cmd}`);
    };

    const log = await cleanupWorktree(worktreePath("maw-js", "2-tile-1"));

    expect(killedTargets).toEqual([]);
    expect(commands).toEqual([
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-2-tile-1' rev-parse --abbrev-ref HEAD",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree remove '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-2-tile-1' --force",
    ]);
    expect(log).toEqual([
      "✗ 'tile-1' is ambiguous — matches 2 windows:",
      "    • neo:neo-tile-1",
      "    • pulse:pulse-tile-1",
      "  skipping window kill — use the full name to disambiguate",
      "worktree remove failed: busy",
    ]);
  });

  test("fuzzy window match reports already-closed windows and continues when branch lookup and fleet IO fail", async () => {
    loadFleetEntriesImpl = () => { throw new Error("missing fleet"); };
    sessions = [{ name: "work", windows: [{ name: "oracle-tile-1" }] }];
    killWindowImpl = () => {
      throw new Error("window missing");
    };
    hostExecImpl = (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) throw new Error("corrupt worktree");
      if (cmd.includes("worktree remove") || cmd.includes("worktree prune")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const log = await cleanupWorktree(worktreePath());

    expect(killedTargets).toEqual(["work:oracle-tile-1"]);
    expect(commands).toEqual([
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-1-tile-1' rev-parse --abbrev-ref HEAD",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree remove '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-1-tile-1' --force",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree prune",
    ]);
    expect(log).toEqual([
      "window already closed: oracle-tile-1",
      "removed worktree maw-js.wt-1-tile-1",
    ]);
  });

  test("no window match still removes the worktree and reports branch deletion failures", async () => {
    addFleetEntry("team.json", { windows: [] });
    sessions = [{ name: "work", windows: [{ name: "lead" }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature/unmerged\n";
      if (cmd.includes("worktree remove") || cmd.includes("worktree prune")) return "";
      if (cmd.includes("branch -d")) throw new Error("not merged");
      throw new Error(`unexpected command: ${cmd}`);
    };

    const log = await cleanupWorktree(worktreePath("maw-js", "3-missing"));

    expect(killedTargets).toEqual([]);
    expect(commands).toEqual([
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-3-missing' rev-parse --abbrev-ref HEAD",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree remove '/ghq/github.com/Soul-Brews-Studio/maw-js.wt-3-missing' --force",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' worktree prune",
      "git -C '/ghq/github.com/Soul-Brews-Studio/maw-js' branch -d 'feature/unmerged'",
    ]);
    expect(log).toEqual([
      "removed worktree maw-js.wt-3-missing",
      "branch feature/unmerged not deleted (may have unmerged changes)",
    ]);
  });
});
