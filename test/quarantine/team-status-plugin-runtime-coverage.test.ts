import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir as realTmpdir } from "os";
import { join } from "path";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

const originalHome = process.env.HOME;
const root = mkdtempSync(join(realTmpdir(), "maw-plugin-team-status-"));
const homeDir = join(root, "home");

process.env.HOME = homeDir;

let hostExecCalls: string[] = [];
let hostExecOutput = "";
let hostExecError: unknown = null;
let tasksByTeam: Record<string, any[]> = {};
let teamsByName: Record<string, any> = {};
let logs: string[] = [];
const originalLog = console.log;

function teamDir(name: string): string {
  return join(homeDir, ".claude", "teams", name);
}

function writeTeamDir(name: string): void {
  mkdirSync(teamDir(name), { recursive: true });
  writeFileSync(join(teamDir(name), ".keep"), "");
}

mock.module("os", () => ({
  homedir: () => homeDir,
  tmpdir: () => realTmpdir(),
}));

mock.module(at("../../src/sdk"), () => ({
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (hostExecError) throw hostExecError;
    return hostExecOutput;
  },
}));

mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskList: (name: string) => tasksByTeam[name] ?? [],
}));

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  loadTeam: (name: string) => teamsByName[name] ?? null,
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  colorAnsi: (color: string) => ({ red: "31", blue: "34", green: "32" } as Record<string, string>)[color] ?? "37",
}));

const { cmdTeamStatus } = await import("../../src/commands/plugins/team/team-status");

function output(): string {
  return logs.join("\n");
}

beforeEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(homeDir, { recursive: true });
  hostExecCalls = [];
  hostExecOutput = "";
  hostExecError = null;
  tasksByTeam = {};
  teamsByName = {};
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

describe("commands plugin team status runtime coverage", () => {
  test("prints no active teams without probing tmux when no team directory exists", async () => {
    await cmdTeamStatus();

    expect(output()).toContain("no active teams");
    expect(hostExecCalls).toEqual([]);
  });

  test("reports an explicitly requested missing team after alive-pane probe failure", async () => {
    hostExecError = new Error("tmux offline");

    await cmdTeamStatus("ghost");

    expect(hostExecCalls).toEqual(["tmux list-panes -a -F '#{pane_id}'"]);
    expect(output()).toContain("team not found: ghost");
  });

  test("renders non-lead members with running/exited state, active task fallback, colors, and totals", async () => {
    writeTeamDir("ops");
    teamsByName.ops = {
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0", color: "red" },
        { name: "alpha", agentId: "a-1", agentType: "executor", tmuxPaneId: "%1", color: "green" },
        { name: "beta", agentType: "verifier", tmuxPaneId: "%2", color: "blue" },
        { name: "gamma", agentType: "researcher" },
      ],
    };
    tasksByTeam.ops = [
      { id: 1, subject: "Investigate production outage now", status: "pending", assignee: "alpha" },
      { id: 2, subject: "Implement immediate fix", status: "in_progress", assignee: "alpha" },
      { id: 3, subject: "Verify final behavior", status: "completed", assignee: "beta" },
      { id: 4, subject: "Unassigned backlog", status: "pending" },
    ];
    hostExecOutput = "%1\n%9\n";

    await cmdTeamStatus("ops");

    const rendered = output();
    expect(hostExecCalls).toEqual(["tmux list-panes -a -F '#{pane_id}'"]);
    expect(rendered).toContain("ops");
    expect(rendered).toContain("(3 agents)");
    expect(rendered).toContain("a-1");
    expect(rendered).toContain("running");
    expect(rendered).toContain("#2 Implement immediat [in");
    expect(rendered).toContain("%1");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("exited");
    expect(rendered).toContain("#3 Verify final behav [do");
    expect(rendered).toContain("gamma");
    expect(rendered).toContain("Tasks: 1/4 done | 1 running, 2 exited");
  });

  test("lists teams from disk and continues past configs that disappear", async () => {
    writeTeamDir("ops");
    writeTeamDir("stale");
    teamsByName.ops = { members: [] };

    await cmdTeamStatus();

    const rendered = output();
    expect(rendered).toContain("ops");
    expect(rendered).toContain("team not found: stale");
    expect(rendered).toContain("Tasks: 0/0 done | 0 running, 0 exited");
  });
});
