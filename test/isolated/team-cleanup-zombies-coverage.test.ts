import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const fleetLoadPath = import.meta.resolve("../../src/commands/shared/fleet-load.ts");

let panes: any[] = [];
let killPaneCalls: string[] = [];
let fleetEntries: Array<{ file: string }> = [];
let listPanesError: Error | null = null;
let logs: string[] = [];
const originalLog = console.log;

mock.module("maw-js/sdk", () => ({
  tmux: {
    listPanes: async () => {
      if (listPanesError) throw listPanesError;
      return panes;
    },
    killPane: async (paneId: string) => {
      killPaneCalls.push(paneId);
    },
  },
}));

mock.module(fleetLoadPath, () => ({
  loadFleetEntries: () => fleetEntries,
}));

const helpers = await import("../../src/vendor/mpr-plugins/team/team-helpers.ts");
const mod = await import("../../src/vendor/mpr-plugins/team/team-cleanup-zombies.ts?team-zombies-coverage");
const { _setDirs } = helpers;
const { cmdCleanupZombies, findZombiePanes } = mod;

const pane = (id: string, target: string, command = "claude", title = id) => ({
  id,
  target,
  command,
  title,
  session: target.split(":")[0] ?? "",
  window: target.split(":")[1]?.split(".")[0] ?? "",
});

let root = "";
let teamsDir = "";
let tasksDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-team-zombies-"));
  teamsDir = join(root, "teams");
  tasksDir = join(root, "tasks");
  _setDirs(teamsDir, tasksDir);
  panes = [];
  killPaneCalls = [];
  fleetEntries = [];
  listPanesError = null;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  rmSync(root, { recursive: true, force: true });
});

describe("team cleanup zombie panes coverage", () => {
  test("findZombiePanes excludes team, fleet, view, linked safe pane ids, and non-claude panes", () => {
    mkdirSync(join(teamsDir, "live"), { recursive: true });
    writeFileSync(join(teamsDir, "live", "config.json"), JSON.stringify({
      name: "live",
      members: [
        { name: "active", tmuxPaneId: "%team" },
        { name: "inline", tmuxPaneId: "in-process" },
        { name: "blank", tmuxPaneId: "" },
      ],
    }));
    mkdirSync(join(teamsDir, "broken"), { recursive: true });
    writeFileSync(join(teamsDir, "broken", "config.json"), "{not-json");

    fleetEntries = [{ file: "01-pulse.json" }, { file: "07-mawjs.json" }];

    const zombies = findZombiePanes([
      pane("%team", "old-team:1.0", "claude", "known team"),
      pane("%fleet", "01-pulse:2.0", "claude", "fleet oracle"),
      pane("%view", "maw-view:1.0", "claude", "view"),
      pane("%oracleView", "mawjs-view:1.0", "claude", "oracle view"),
      pane("%linked", "07-mawjs:3.0", "claude", "linked fleet safe"),
      pane("%linked", "scratch:3.0", "claude", "same pane id should be safe"),
      pane("%shell", "scratch:4.0", "zsh", "shell only"),
      pane("%zombie", "deleted:5.0", "claude --dangerously-skip-permissions", "a very long orphaned title that should be clipped after fifty characters"),
    ] as any[]);

    expect(zombies).toEqual([
      {
        paneId: "%zombie",
        teamName: "unknown",
        info: 'deleted:5.0  "a very long orphaned title that should be clipped "',
      },
    ]);
  });

  test("findZombiePanes degrades safely when teams and fleet loaders fail", () => {
    // No teams dir: the target catches filesystem absence and keeps scanning panes.
    fleetEntries = [];

    const zombies = findZombiePanes([
      pane("%candidate", "scratch:1.0", "claude", "candidate"),
      pane("%view", "scratch-view:1.0", "claude", "view safe"),
    ] as any[]);

    expect(zombies.map(z => z.paneId)).toEqual(["%candidate"]);
    expect(zombies[0]?.info).toContain('"candidate"');
  });

  test("cmdCleanupZombies reports no-op, dry-run, and kill paths", async () => {
    panes = [pane("%safe", "maw-view:1.0", "claude", "safe")];
    await cmdCleanupZombies();
    expect(logs.join("\n")).toContain("No zombie agent panes found");
    expect(killPaneCalls).toEqual([]);

    logs = [];
    panes = [pane("%z1", "dead:2.0", "claude", "zombie one")];
    await cmdCleanupZombies();
    expect(logs.join("\n")).toContain("Found");
    expect(logs.join("\n")).toContain("--yes");
    expect(killPaneCalls).toEqual([]);

    logs = [];
    await cmdCleanupZombies({ yes: true });
    expect(killPaneCalls).toEqual(["%z1"]);
    expect(logs.join("\n")).toContain("killed %z1");
  });
});
