import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

type TeamMember = {
  name: string;
  agentId?: string;
  agentType?: string;
  tmuxPaneId?: string;
  color?: string;
};

type Team = {
  name: string;
  members: TeamMember[];
};

type InboxMessage = {
  type: "done" | "stuck" | "progress" | "status";
  from: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

const calls: Record<string, unknown[][]> = {
  cmdTeamCreate: [],
  cmdTeamSpawn: [],
  cmdTeamSend: [],
  cmdTeamResume: [],
  cmdTeamLives: [],
  cmdTeamShutdown: [],
  cmdTeamList: [],
  cmdTeamTaskAdd: [],
  cmdTeamTaskList: [],
  cmdTeamTaskDone: [],
  cmdTeamTaskAssign: [],
  cmdTeamStatus: [],
  cmdTeamDelete: [],
  cmdTeamInvite: [],
  cmdOracleInvite: [],
  cmdOracleRemove: [],
  cmdOracleMembers: [],
  cmdSplit: [],
  cmdTmuxPeek: [],
  hostExec: [],
  withPaneLock: [],
  stylePaneBorder: [],
  enableBorderStatus: [],
  applyTeamLayout: [],
  applyTiledLayout: [],
  readUnread: [],
  readInbox: [],
  markRead: [],
  loadLayoutSnapshot: [],
  loadTeam: [],
};

let homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-home-"));
let teamsDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-teams-"));
let loadTeamResult: Team | undefined;
let hostExecQueue: Array<string | Error> = [];
let childExecResult: string | Error = "";
let throwOnResume = false;
let listViaError = false;
let unreadMessages: InboxMessage[] = [];
let inboxMessages: InboxMessage[] = [];
let markReadResult = 0;
let layoutSnapshot: any = null;

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => { calls.cmdTeamSpawn.push(args); },
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamResume: (...args: unknown[]) => {
    if (throwOnResume) throw new Error("resume exploded");
    calls.cmdTeamResume.push(args);
  },
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => { calls.cmdTeamShutdown.push(args); },
  cmdTeamList: () => {
    calls.cmdTeamList.push([]);
    if (listViaError) console.error("listed on stderr");
  },
}));

mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => calls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.cmdTeamTaskAssign.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-status"), () => ({
  cmdTeamStatus: async (...args: unknown[]) => { calls.cmdTeamStatus.push(args); },
}));

mock.module(at("../../src/commands/plugins/team/team-cleanup"), () => ({
  cmdTeamDelete: async (...args: unknown[]) => { calls.cmdTeamDelete.push(args); },
}));

mock.module(at("../../src/commands/plugins/team/team-invite"), () => ({
  cmdTeamInvite: async (...args: unknown[]) => { calls.cmdTeamInvite.push(args); },
}));

mock.module(at("../../src/commands/plugins/team/oracle-members"), () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.cmdOracleMembers.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-helpers"), () => ({
  TEAMS_DIR: teamsDir,
  loadTeam: (...args: unknown[]) => {
    calls.loadTeam.push(args);
    return loadTeamResult;
  },
}));

mock.module(at("../../src/commands/plugins/split/impl"), () => ({
  cmdSplit: (...args: unknown[]) => calls.cmdSplit.push(args),
}));

mock.module(at("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxPeek: async (...args: unknown[]) => { calls.cmdTmuxPeek.push(args); },
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (i: number) => ["red", "green", "blue"][i] ?? "white",
  colorAnsi: (color: string) => ({ red: "31", green: "32", blue: "34", white: "37" } as Record<string, string>)[color] ?? "35",
  stylePaneBorder: async (...args: unknown[]) => { calls.stylePaneBorder.push(args); },
  enableBorderStatus: async (...args: unknown[]) => { calls.enableBorderStatus.push(args); },
  applyTeamLayout: async (...args: unknown[]) => { calls.applyTeamLayout.push(args); },
  applyTiledLayout: async (...args: unknown[]) => { calls.applyTiledLayout.push(args); },
  getWindowTarget: async () => "win:1",
}));

mock.module(at("../../src/commands/plugins/team/inbox"), () => ({
  readUnread: (...args: unknown[]) => {
    calls.readUnread.push(args);
    return unreadMessages;
  },
  readInbox: (...args: unknown[]) => {
    calls.readInbox.push(args);
    return inboxMessages;
  },
  markRead: (...args: unknown[]) => {
    calls.markRead.push(args);
    return markReadResult;
  },
}));

mock.module(at("../../src/commands/plugins/team/layout-snapshot"), () => ({
  loadLayoutSnapshot: (...args: unknown[]) => {
    calls.loadLayoutSnapshot.push(args);
    return layoutSnapshot;
  },
}));

mock.module(at("../../src/cli/parse-args"), () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    for (let i = startIndex; i < args.length; i++) {
      const token = args[i] ?? "";
      if (token in schema) {
        const type = schema[token];
        if (type === Boolean) out[token] = true;
        else if (type === Number) {
          out[token] = Number(args[i + 1] ?? 0);
          i++;
        } else {
          out[token] = args[i + 1] ?? "";
          i++;
        }
      } else {
        (out._ as string[]).push(token);
      }
    }
    return out;
  },
}));

mock.module(at("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    calls.hostExec.push([cmd]);
    const next = hostExecQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  withPaneLock: async (fn: () => Promise<void>) => {
    calls.withPaneLock.push([]);
    return fn();
  },
}));

const { default: teamHandler } = await import("../../src/commands/plugins/team/index");

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
}

function resetEnv() {
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
}

function writeHomeTeamConfig(teamName: string) {
  const teamDir = join(homeDir, ".claude", "teams", teamName);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({ name: teamName }));
}

function writeCommandTeamConfig(teamName: string, members: TeamMember[]) {
  const teamDir = join(teamsDir, teamName);
  mkdirSync(teamDir, { recursive: true });
  const path = join(teamDir, "config.json");
  writeFileSync(path, JSON.stringify({ name: teamName, members }, null, 2));
  return path;
}

beforeEach(() => {
  resetCalls();
  resetEnv();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(teamsDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-home-"));
  mkdirSync(teamsDir, { recursive: true });
  loadTeamResult = undefined;
  hostExecQueue = [];
  childExecResult = "";
  throwOnResume = false;
  listViaError = false;
  unreadMessages = [];
  inboxMessages = [];
  markReadResult = 0;
  layoutSnapshot = null;
});

afterEach(() => {
  resetEnv();
});

describe("team index extra isolated coverage", () => {
  test("covers usage-only branches without dispatching real helpers", async () => {
    const cases: Array<{ args: string[]; error: string; output?: string; tmux?: boolean }> = [
      { args: ["create"], error: "name required", output: "usage: maw team create" },
      { args: ["rm"], error: "usage: maw team delete <team-name>" },
      { args: ["invite", "room"], error: "team and peer required", output: "usage: maw team invite" },
      { args: ["open"], error: "target required", output: "usage: maw team open" },
      { args: ["peek"], error: "target required", output: "usage: maw team peek" },
      { args: ["prep"], error: "not in tmux" },
      { args: ["prep", "0"], error: "count required (1-10)", tmux: true },
      { args: ["broadcast"], error: "message required", output: "usage: maw team broadcast" },
      { args: ["hey", "alice"], error: "agent and message required", output: "usage: maw team hey" },
      { args: ["layout"], error: "not in tmux" },
    ];

    for (const c of cases) {
      resetEnv();
      if (c.tmux) process.env.TMUX = "/tmp/tmux";
      const result = await teamHandler({ source: "cli", args: c.args });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(c.error);
      if (c.output) expect(`${result.output ?? result.error}`).toContain(c.output);
    }

    expect(calls.cmdTeamCreate).toHaveLength(0);
    expect(calls.cmdTeamDelete).toHaveLength(0);
    expect(calls.cmdTeamInvite).toHaveLength(0);
    expect(calls.cmdSplit).toHaveLength(0);
    expect(calls.cmdTmuxPeek).toHaveLength(0);
  });

  test("dispatches split, peek, delete, invite, status, and resume error handling", async () => {
    let result = await teamHandler({ source: "cli", args: ["split", "agent-a", "--pct", "42", "--vertical"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdSplit).toEqual([["agent-a", { pct: 42, vertical: true, lock: true }]]);

    result = await teamHandler({ source: "cli", args: ["peek", "agent-a"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTmuxPeek).toEqual([["agent-a"]]);

    result = await teamHandler({ source: "cli", args: ["delete", "old-team"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamDelete).toEqual([["old-team"]]);

    result = await teamHandler({ source: "cli", args: ["invite", "room", "peer", "--scope", "repo", "--lead", "nat"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamInvite).toEqual([["room", "peer", { scope: "repo", lead: "nat" }]]);

    result = await teamHandler({ source: "cli", args: ["status", "room"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamStatus).toEqual([["room"]]);

    throwOnResume = true;
    result = await teamHandler({ source: "cli", args: ["resume", "room"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("resume exploded");
  });

  test("resolves team context from a unique home config without tmux", async () => {
    writeHomeTeamConfig("single-team");

    const result = await teamHandler({ source: "cli", args: ["tasks"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskList).toEqual([["single-team"]]);
  });

  test("resolves team context from the active tmux session when its config exists", async () => {
    process.env.TMUX = "socket,123,0";
    childExecResult = "12-active-team\n";
    writeHomeTeamConfig("active-team");
    const childProcess = require("child_process");
    const originalExecFileSync = childProcess.execFileSync;
    childProcess.execFileSync = () => {
      if (childExecResult instanceof Error) throw childExecResult;
      return childExecResult;
    };
    try {
      const result = await teamHandler({ source: "cli", args: ["tasks"] });
      expect(result.ok).toBe(true);
      expect(calls.cmdTeamTaskList).toEqual([["active-team"]]);
    } finally {
      childProcess.execFileSync = originalExecFileSync;
    }
  });


  test("falls back when active tmux session probing fails", async () => {
    process.env.TMUX = "socket,123,0";
    childExecResult = new Error("tmux failed");
    const childProcess = require("child_process");
    const originalExecFileSync = childProcess.execFileSync;
    childProcess.execFileSync = () => {
      if (childExecResult instanceof Error) throw childExecResult;
      return childExecResult;
    };
    try {
      const result = await teamHandler({ source: "cli", args: ["tasks"] });
      expect(result.ok).toBe(true);
      expect(calls.cmdTeamTaskList).toEqual([["default"]]);
    } finally {
      childProcess.execFileSync = originalExecFileSync;
    }
  });

  test("captures stderr output from command helpers", async () => {
    listViaError = true;
    const result = await teamHandler({ source: "cli", args: ["list"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("listed on stderr");
  });

  test("close handles no-op panes, current pane skip, and kill failures", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%1";
    hostExecQueue = ["%1\n"];

    let result = await teamHandler({ source: "cli", args: ["close"] });
    expect(result.ok).toBe(true);
    expect(calls.hostExec).toEqual([["tmux list-panes -F '#{pane_id}'"]]);

    resetCalls();
    hostExecQueue = ["%1\n%2\n%3\n", "", new Error("dead pane")];
    result = await teamHandler({ source: "cli", args: ["close"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("closed 1 pane");
    expect(calls.hostExec).toEqual([
      ["tmux list-panes -F '#{pane_id}'"],
      ["tmux kill-pane -t '%2'"],
      ["tmux kill-pane -t '%3'"],
    ]);
  });

  test("broadcast rejects missing teams and sends to non-lead panes with escaped text", async () => {
    process.env.MAW_TEAM = "room";

    let result = await teamHandler({ source: "cli", args: ["broadcast", "hello"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team not found");

    resetCalls();
    loadTeamResult = {
      name: "room",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "alice", agentId: "alice@room", tmuxPaneId: "%1", color: "red" },
        { name: "bob" },
        { name: "cara", tmuxPaneId: "%3" },
      ],
    };
    hostExecQueue = [new Error("dead"), ""];

    result = await teamHandler({ source: "cli", args: ["shout", "hi", "'team'"] });
    expect(result.ok).toBe(true);
    expect(String(calls.hostExec[0]?.[0])).toContain("tmux send-keys -t '%1'");
    expect(String(calls.hostExec[1]?.[0])).toContain("tmux send-keys -t '%3'");
    expect(result.output).toContain("broadcast to 1/2 agents: hi 'team'");
  });

  test("hey covers missing team, missing pane, and successful escaped send", async () => {
    process.env.MAW_TEAM = "room";

    let result = await teamHandler({ source: "cli", args: ["hey", "alice", "hello"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team not found");

    loadTeamResult = {
      name: "room",
      members: [
        { name: "alice", agentId: "alice@room" },
        { name: "bob", agentId: "bob@room", tmuxPaneId: "%2", color: "blue" },
      ],
    };

    result = await teamHandler({ source: "cli", args: ["hey", "alice", "hello"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent not found");

    result = await teamHandler({ source: "cli", args: ["hey", "bob", "it's", "ready"] });
    expect(result.ok).toBe(true);
    expect(String(calls.hostExec.at(-1)?.[0])).toContain("tmux send-keys -t '%2'");
    expect(result.output).toContain("sent to bob@room: it's ready");
  });

  test("enter reports available pane-backed members and sends to a matching agent id", async () => {
    process.env.MAW_TEAM = "room";
    loadTeamResult = {
      name: "room",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "alice", agentId: "alice@room", tmuxPaneId: "%1", color: "red" },
        { name: "bob", agentId: "bob@room", tmuxPaneId: "%2", color: "blue" },
      ],
    };

    let result = await teamHandler({ source: "cli", args: ["enter", "missing"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent not found");

    resetCalls();
    result = await teamHandler({ source: "cli", args: ["enter", "alice@room"] });
    expect(result.ok).toBe(true);
    expect(calls.hostExec).toEqual([["tmux send-keys -t '%1' Enter"]]);
    expect(result.output).toContain("enter sent to alice@room");
  });

  test("enter reports a missing context team before member lookup", async () => {
    const result = await teamHandler({ source: "cli", args: ["enter", "alice"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team not found");
  });

  test("layout applies both tiled and main-vertical tmux layouts", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%leader";

    let result = await teamHandler({ source: "cli", args: ["layout", "tiled"] });
    expect(result.ok).toBe(true);
    expect(calls.applyTiledLayout).toEqual([["win:1"]]);

    result = await teamHandler({ source: "cli", args: ["layout", "main-vertical", "--pct", "45"] });
    expect(result.ok).toBe(true);
    expect(calls.applyTeamLayout).toEqual([["win:1", "%leader", 45]]);
  });

  test("inbox reads unread messages and mark-read messages", async () => {
    process.env.MAW_TEAM = "room";

    let result = await teamHandler({ source: "cli", args: ["inbox"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no unread messages for leader@room");
    expect(calls.readUnread).toEqual([["room", "leader"]]);

    inboxMessages = [
      { type: "done", from: "alice", timestamp: 0, payload: { text: "finished" } },
      { type: "stuck", from: "bob", timestamp: 0, payload: { reason: "blocked" } },
      { type: "progress", from: "cara", timestamp: 0, payload: { pct: 50 } },
      { type: "status", from: "dee", timestamp: 0, payload: { state: "ok" } },
    ];
    markReadResult = 2;

    result = await teamHandler({ source: "cli", args: ["inbox", "qa", "--mark-read"] });
    expect(result.ok).toBe(true);
    expect(calls.readInbox).toEqual([["room", "qa"]]);
    expect(calls.markRead).toEqual([["room", "qa"]]);
    expect(result.output).toContain("4 messages");
    expect(result.output).toContain("marked 2 messages read");
  });

  test("prep opens one mocked pane and upserts the team config", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.MAW_TEAM = "prep-team";
    process.env.TMUX_PANE = "%leader";
    const configPath = writeCommandTeamConfig("prep-team", [{ name: "agent-1", agentId: "old@prep-team" }]);
    hostExecQueue = ["%new\n"];

    const result = await teamHandler({ source: "cli", args: ["prep", "1"] });

    expect(result.ok).toBe(true);
    expect(calls.withPaneLock).toHaveLength(1);
    expect(calls.stylePaneBorder).toEqual([["%new", "agent-1", "red"]]);
    expect(calls.applyTeamLayout).toEqual([["win:1", "%leader"]]);
    expect(calls.enableBorderStatus).toEqual([["win:1"]]);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).members).toEqual([
      { name: "agent-1", agentId: "agent-1@prep-team", tmuxPaneId: "%new", color: "red", model: "shell" },
    ]);
  });

  test("prep --tiled applies the tiled layout after pane creation", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.MAW_TEAM = "prep-tiled";
    process.env.TMUX_PANE = "%leader";
    writeCommandTeamConfig("prep-tiled", []);
    hostExecQueue = ["%tile\n"];

    const result = await teamHandler({ source: "cli", args: ["prep", "1", "--tiled"] });

    expect(result.ok).toBe(true);
    expect(calls.applyTiledLayout).toEqual([["win:1"]]);
    expect(calls.applyTeamLayout).toEqual([]);
    expect(result.output).toContain("tiled");
  });

  test("recover reports missing snapshots and restores alive panes from a snapshot", async () => {
    process.env.MAW_TEAM = "room";

    let result = await teamHandler({ source: "cli", args: ["recover"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no snapshot");
    expect(calls.loadLayoutSnapshot).toEqual([["room"]]);

    resetCalls();
    process.env.TMUX_PANE = "%leader-now";
    layoutSnapshot = {
      savedAt: Date.now() - 120_000,
      leaderPane: "%leader-old",
      panes: [
        { name: "alice", agentId: "alice@room", tmuxPaneId: "%1", color: "red" },
        { name: "bob", agentId: "bob@room", tmuxPaneId: "%2", color: "blue" },
      ],
    };
    hostExecQueue = ["%1\n"];

    result = await teamHandler({ source: "cli", args: ["recover", "room"] });
    expect(result.ok).toBe(true);
    expect(calls.stylePaneBorder).toEqual([["%1", "alice", "red"]]);
    expect(calls.applyTeamLayout).toEqual([["win:1", "%leader-now"]]);
    expect(calls.enableBorderStatus).toEqual([["win:1"]]);
    expect(result.output).toContain("recovered 1 pane, 1 dead");
  });
});
