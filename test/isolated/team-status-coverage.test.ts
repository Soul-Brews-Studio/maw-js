import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir as realTmpdir } from "os";
import { join } from "path";

const originalHome = process.env.HOME;
const originalMawConfigDir = process.env.MAW_CONFIG_DIR;
const root = mkdtempSync(join(realTmpdir(), "maw-team-status-"));
const homeDir = join(root, "home");
const configDir = join(root, "config");

process.env.HOME = homeDir;
process.env.MAW_CONFIG_DIR = configDir;

let hostExecCalls: string[] = [];
let hostExecOutput = "";
let hostExecError: unknown = null;
let logs: string[] = [];
const originalLog = console.log;

function teamDir(name: string): string {
  return join(homeDir, ".claude", "teams", name);
}

mock.module("os", () => ({
  homedir: () => homeDir,
  tmpdir: () => realTmpdir(),
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (hostExecError) throw hostExecError;
    return hostExecOutput;
  },
}));

mock.module("../../src/vendor/mpr-plugins/team/impl", () => ({
  loadTeam: (name: string) => {
    const configPath = join(teamDir(name), "config.json");
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8"));
  },
}));

const { cmdTeamStatus } = await import("../../src/vendor/mpr-plugins/team/team-status.ts?team-status-coverage");

type TaskStatus = "pending" | "in_progress" | "completed";

function taskDir(name: string): string {
  return join(configDir, "teams", name, "tasks");
}

function writeTeam(name: string): void {
  mkdirSync(teamDir(name), { recursive: true });
  writeFileSync(join(teamDir(name), "config.json"), JSON.stringify({
    name,
    members: [
      { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
      { name: "alpha", agentType: "executor", tmuxPaneId: "%1" },
      { name: "beta", agentType: "verifier", tmuxPaneId: "%2" },
      { name: "gamma", agentType: "researcher" },
    ],
  }, null, 2));
}

function writeTask(team: string, id: number, subject: string, status: TaskStatus, assignee?: string): void {
  mkdirSync(taskDir(team), { recursive: true });
  writeFileSync(join(taskDir(team), `${id}.json`), JSON.stringify({
    id,
    subject,
    status,
    ...(assignee ? { assignee } : {}),
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
  }, null, 2));
}

function output(): string {
  return logs.join("\n");
}

beforeEach(() => {
  rmSync(join(homeDir, ".claude"), { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  hostExecCalls = [];
  hostExecOutput = "";
  hostExecError = null;
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
  if (originalMawConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalMawConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe("vendor team status isolated coverage", () => {
  test("prints no active teams without probing tmux when the teams directory is absent", async () => {
    await cmdTeamStatus();

    expect(output()).toContain("no active teams");
    expect(hostExecCalls).toEqual([]);
  });

  test("discovers team directories when no explicit team name is provided", async () => {
    writeTeam("ops");
    const teamsRoot = join(homeDir, ".claude", "teams");
    writeFileSync(join(teamsRoot, "README.txt"), "not a team directory");
    writeTask("ops", 1, "Keep coverage high", "completed", "alpha");
    hostExecOutput = "%1 ops:0 zsh";

    await cmdTeamStatus();

    expect(hostExecCalls).toEqual([
      "tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index} #{pane_current_command}'",
    ]);
    expect(output()).toContain("Team: ops");
    expect(output()).toContain("Tasks: 1/1 done");
  });

  test("warns for an explicitly requested missing team after a safe tmux probe failure", async () => {
    hostExecError = new Error("tmux unavailable");

    await cmdTeamStatus("ghosts");

    expect(hostExecCalls).toEqual([
      "tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index} #{pane_current_command}'",
    ]);
    expect(output()).toContain("team not found: ghosts");
  });

  test("renders member task statuses and task summary when tmux pane lookup succeeds", async () => {
    writeTeam("ops");
    writeTask("ops", 1, "Investigate production outage now", "in_progress", "alpha");
    writeTask("ops", 2, "Review final report", "completed", "beta");
    writeTask("ops", 3, "Plan next iteration", "pending", "gamma");
    writeTask("ops", 4, "Unassigned backlog", "pending");
    hostExecOutput = [
      "%1 ops:0 zsh",
      "%2 ops:0 bun",
      "%9 scratch:1 node",
    ].join("\n");

    await cmdTeamStatus("ops");

    const rendered = output();
    expect(hostExecCalls).toEqual([
      "tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index} #{pane_current_command}'",
    ]);
    expect(rendered).toContain("tasks for team \"ops\" (4):");
    expect(rendered).toContain("Team: ops");
    expect(rendered).toContain("(3 agents)");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("working");
    expect(rendered).toContain("#1 Investigate producti [in_p");
    expect(rendered).toContain("%1");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("idle");
    expect(rendered).toContain("#2 Review final report [done]");
    expect(rendered).toContain("%2");
    expect(rendered).toContain("gamma");
    expect(rendered).toContain("#3 Plan next iteration [pendi");
    expect(rendered).toContain("Tasks: 1/4 done | Agents: 1 working, 2 idle");
  });
});
