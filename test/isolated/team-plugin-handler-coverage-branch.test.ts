import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

const calls: Record<string, unknown[]> = {
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
};

type MockTeam = { name: string; members: Array<{ name: string; tmuxPaneId?: string; agentType?: string; color?: string; agentId?: string }> };
let tmuxSession = "3-team-alpha";
let loadTeamResult: MockTeam | null = null;
let readUnreadMessages: Array<{ type: "done" | "stuck" | "progress" | "status" | "shutdown"; from: string; to: string; timestamp: number; payload: Record<string, unknown> }> = [];
let readInboxMessages: typeof readUnreadMessages = [];
let markReadResult = 0;
let snapshot: any = null;
let hostExecMap: Record<string, string> = {};
let homedirPath = mkdtempSync(join(tmpdir(), "maw-team-handler-"));
const originalPath = process.env.PATH ?? "";

mock.module("os", () => ({
  homedir: () => homedirPath,
}));

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => { calls.cmdTeamSpawn.push(args); },
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
  cmdTeamShutdown: (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
  cmdTeamList: () => { calls.cmdTeamList.push([]); },
}));

mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => calls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.cmdTeamTaskAssign.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-status"), () => ({
  cmdTeamStatus: async (...args: unknown[]) => calls.cmdTeamStatus.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-cleanup"), () => ({
  cmdTeamDelete: (...args: unknown[]) => calls.cmdTeamDelete.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-invite"), () => ({
  cmdTeamInvite: (...args: unknown[]) => calls.cmdTeamInvite.push(args),
}));

mock.module(at("../../src/commands/plugins/team/oracle-members"), () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.cmdOracleMembers.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-helpers"), () => ({
  TEAMS_DIR: "/tmp/teams",
  loadTeam: () => loadTeamResult,
}));

mock.module(at("../../src/commands/plugins/split/impl"), () => ({
  cmdSplit: (...args: unknown[]) => calls.cmdSplit.push(args),
}));

mock.module(at("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxPeek: (...args: unknown[]) => calls.cmdTmuxPeek.push(args),
}));

mock.module(at("../../src/cli/parse-args"), () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    for (let i = startIndex; i < args.length; i++) {
      const token = args[i];
      if (token in schema) {
        const v = schema[token];
        if (v === Boolean) out[token] = true;
        else if (v === Number) {
          out[token] = Number(args[i + 1] ?? 0);
          i++;
        }
        else { out[token] = args[i + 1] ?? ""; i++; }
      } else {
        (out._ as string[]).push(token);
      }
    }
    return out;
  },
}));

mock.module(at("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    calls.hostExec.push(cmd);
    return hostExecMap[cmd] ?? "";
  },
  withPaneLock: async (fn: () => Promise<void>) => {
    calls.withPaneLock.push([]);
    return fn();
  },
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (i: number) => `c${i}`,
  colorAnsi: () => "35",
  stylePaneBorder: async () => {},
  enableBorderStatus: async () => {},
  applyTeamLayout: async () => {},
  applyTiledLayout: async () => {},
  getWindowTarget: async () => "win",
}));

mock.module(at("../../src/commands/plugins/team/inbox"), () => ({
  readUnread: () => readUnreadMessages,
  readInbox: () => readInboxMessages,
  markRead: () => markReadResult,
}));

mock.module(at("../../src/commands/plugins/team/layout-snapshot"), () => ({
  loadLayoutSnapshot: () => snapshot,
}));

const { default: teamHandler } = await import("../../src/commands/plugins/team/index");

function reset() {
  for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = [];
  rmSync(homedirPath, { recursive: true, force: true });
  homedirPath = mkdtempSync(join(tmpdir(), "maw-team-handler-"));
  tmuxSession = "3-team-alpha";
  loadTeamResult = null;
  readUnreadMessages = [];
  readInboxMessages = [];
  markReadResult = 0;
  snapshot = null;
  hostExecMap = {};
  process.env.PATH = originalPath;
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
}

function writeTeamConfig(teamName: string) {
  const teamsDir = join(homedirPath, ".claude", "teams", teamName);
  mkdirSync(teamsDir, { recursive: true });
  writeFileSync(join(teamsDir, "config.json"), JSON.stringify({ name: teamName, members: [] }));
}

function installFakeTmux(sessionName: string) {
  const binDir = join(homedirPath, "bin");
  const tmuxPath = join(binDir, "tmux");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(tmuxPath, `#!/bin/sh\nprintf '%s\\n' '${sessionName}'\n`);
  chmodSync(tmuxPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;
}

beforeEach(() => {
  reset();
});

describe("team handler coverage slice: remaining branches", () => {
  test("resolveTeamFromContext uses env override and create command", async () => {
    process.env.MAW_TEAM = "env-team";
    const result = await teamHandler({ source: "cli", args: ["create", "blue", "--description", "coverage"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamCreate).toEqual([["blue", { description: "coverage" }]]);
  });

  test.skip("resolveTeamFromContext uses tmux session name when env is unset", async () => {
    delete process.env.MAW_TEAM;
    process.env.TMUX = "1";
    installFakeTmux(tmuxSession);
    writeTeamConfig("team-alpha");
    await teamHandler({ source: "cli", args: ["add", "onboarding"] });
    expect(calls.cmdTeamTaskAdd).toEqual([[
      "team-alpha",
      "onboarding",
      { assign: undefined, description: undefined },
    ]]);
  });

  test("resolveTeamFromContext falls back to single configured team", async () => {
    delete process.env.MAW_TEAM;
    writeTeamConfig("solo");
    await teamHandler({ source: "cli", args: ["tasks"] });
    expect(calls.cmdTeamTaskList).toEqual([["solo"]]);
  });

  test("spawn parses prompt/model/cwd/exec args", async () => {
    process.env.MAW_TEAM = "env-team";
    await teamHandler({ source: "cli", args: ["spawn", "team-a", "engineer", "--model", "gpt-5", "--worktree", "/tmp/w", "--prompt", "hello", "there", "--exec"] });
    expect(calls.cmdTeamSpawn).toEqual([[ "team-a", "engineer", {
      model: "gpt-5",
      prompt: "hello there",
      exec: true,
      cwd: "/tmp/w",
    } ]]);
  });

  test("send/msg aliases both route through single/ group dispatch", async () => {
    await teamHandler({ source: "cli", args: ["send", "team-a", "agent", "hi", "there"] });
    expect(calls.cmdTeamSend).toEqual([["team-a", "agent", "hi there"]]);
    await teamHandler({ source: "cli", args: ["msg", "team-a", "agent", "yo"] });
    expect(calls.cmdTeamSend).toEqual([["team-a", "agent", "hi there"], ["team-a", "agent", "yo"]]);
  });

  test("resume/lives/shutdown/list dispatch", async () => {
    await teamHandler({ source: "cli", args: ["resume", "team-x", "--model", "gpt-5"] });
    await teamHandler({ source: "cli", args: ["lives", "agent-a"] });
    await teamHandler({ source: "cli", args: ["shutdown", "team-x", "--force", "--merge"] });
    await teamHandler({ source: "cli", args: ["list"] });
    expect(calls.cmdTeamResume).toEqual([["team-x", { model: "gpt-5" }]]);
    expect(calls.cmdTeamLives).toEqual([["agent-a"]]);
    expect(calls.cmdTeamShutdown).toEqual([[ "team-x", { force: true, merge: true } ]]);
    expect(calls.cmdTeamList).toHaveLength(1);
  });

  test("done and assign dispatch with team resolution", async () => {
    process.env.MAW_TEAM = "env-team";
    await teamHandler({ source: "cli", args: ["done", "12"] });
    await teamHandler({ source: "cli", args: ["assign", "7", "orion"] });
    expect(calls.cmdTeamTaskDone).toEqual([["env-team", 12]]);
    expect(calls.cmdTeamTaskAssign).toEqual([["env-team", 7, "orion"]]);
  });

  test("status/delete/invite/oracle invite/remove/members with explicit and positional team", async () => {
    await teamHandler({ source: "cli", args: ["status", "team-s"] });
    await teamHandler({ source: "cli", args: ["delete", "team-s"] });
    await teamHandler({ source: "cli", args: ["invite", "team-s", "peer-a", "--scope", "local"] });
    await teamHandler({ source: "cli", args: ["oracle-invite", "oracle-a", "--team", "team-s", "--role", "lead"] });
    await teamHandler({ source: "cli", args: ["oracle-remove", "oracle-b", "--team", "team-s"] });
    await teamHandler({ source: "cli", args: ["members", "--team", "team-s"] });
    expect(calls.cmdTeamStatus).toEqual([["team-s"]]);
    expect(calls.cmdTeamDelete).toEqual([["team-s"]]);
    expect(calls.cmdTeamInvite).toEqual([["team-s", "peer-a", { scope: "local", lead: undefined }]]);
    expect(calls.cmdOracleInvite).toEqual([["team-s", "oracle-a", { role: "lead" }]]);
    expect(calls.cmdOracleRemove).toEqual([["team-s", "oracle-b"]]);
    expect(calls.cmdOracleMembers).toEqual([["team-s"]]);
  });

  test("split and peek dispatch", async () => {
    await teamHandler({ source: "cli", args: ["split", "agent-1", "--pct", "37", "--vertical"] });
    await teamHandler({ source: "cli", args: ["peek", "agent-1"] });
    expect(calls.cmdSplit).toEqual([["agent-1", { pct: 37, vertical: true, lock: true }]]);
    expect(calls.cmdTmuxPeek).toEqual([["agent-1"]]);
  });

  test("close handles no-tmux and split panes", async () => {
    const noTmux = await teamHandler({ source: "cli", args: ["close"] });
    expect(noTmux.error).toBe("not in tmux");

    process.env.TMUX = "1";
    hostExecMap["tmux list-panes -F '#{pane_id}'"] = "Y";
    let close = await teamHandler({ source: "cli", args: ["close"] });
    expect(close.ok).toBe(true);

    hostExecMap["tmux list-panes -F '#{pane_id}'"] = "X\nY\nZ";
    hostExecMap["tmux kill-pane -t 'X'"] = "";
    hostExecMap["tmux kill-pane -t 'Z'"] = "";
    process.env.TMUX_PANE = "Y";
    close = await teamHandler({ source: "cli", args: ["close"] });
    expect(close.ok).toBe(true);
    expect(calls.hostExec.slice(-3)).toEqual([
      "tmux list-panes -F '#{pane_id}'",
      "tmux kill-pane -t 'X'",
      "tmux kill-pane -t 'Z'",
    ]);
  });

  test("prep and layout reject non-tmux or invalid counts before side effects", async () => {
    let result = await teamHandler({ source: "cli", args: ["prep", "2"] });
    expect(result.error).toBe("not in tmux");

    process.env.TMUX = "1";
    result = await teamHandler({ source: "cli", args: ["prep", "0"] });
    expect(result.error).toBe("count required (1-10)");

    delete process.env.TMUX;
    result = await teamHandler({ source: "cli", args: ["layout"] });
    expect(result.error).toBe("not in tmux");
  });

  test("prep branches without existing config and applies layout", async () => {
    process.env.TMUX = "1";
    process.env.MAW_TEAM = "team-alpha";
    loadTeamResult = { name: "team-alpha", members: [] };
    writeTeamConfig("team-alpha");
    hostExecMap["tmux split-window -h -P -F '#{pane_id}' 'echo \"\\x1b[35magent-1 ready\\x1b[0m\" && exec zsh'"] = "agentPane";
    const result = await teamHandler({ source: "cli", args: ["prep", "1"] });
    expect(result.ok).toBe(true);
    expect(calls.withPaneLock).toHaveLength(1);
  });

  test("broadcast success and enter/h e y agent resolution", async () => {
    loadTeamResult = {
      name: "env-team",
      members: [
        { name: "lead", agentType: "team-lead" },
        { name: "a1", agentId: "a1@env-team", tmuxPaneId: "P1", color: "green" },
      ],
    };
    process.env.MAW_TEAM = "env-team";
    let res = await teamHandler({ source: "cli", args: ["broadcast", "ping!"] });
    expect(res.ok).toBe(true);

    res = await teamHandler({ source: "cli", args: ["enter", "a1"] });
    expect(res.ok).toBe(true);

    res = await teamHandler({ source: "cli", args: ["hey", "a1", "hello"] });
    expect(res.ok).toBe(true);
  });

  test("hey and enter handle missing agents", async () => {
    loadTeamResult = { name: "env-team", members: [{ name: "lead", agentId: "lead@env-team" }] };
    process.env.MAW_TEAM = "env-team";
    const enter = await teamHandler({ source: "cli", args: ["enter", "agent-x"] });
    expect(enter.ok).toBe(false);
    expect(enter.error).toBe("agent not found");

    const hey = await teamHandler({ source: "cli", args: ["hey", "agent-x", "yo"] });
    expect(hey.ok).toBe(false);
    expect(hey.error).toBe("agent not found");
  });

  test("layout handles tiled and main-vertical branches", async () => {
    process.env.TMUX = "1";
    let res = await teamHandler({ source: "cli", args: ["layout", "tiled"] });
    expect(res.ok).toBe(true);

    res = await teamHandler({ source: "cli", args: ["layout", "main-vertical", "--pct", "40"] });
    expect(res.ok).toBe(true);
  });

  test("inbox read and mark-read paths", async () => {
    process.env.MAW_TEAM = "env-team";
    readUnreadMessages = [{ type: "done", from: "m1", to: "leader", timestamp: Date.now(), payload: { summary: "s" } }];
    readInboxMessages = [{ type: "stuck", from: "m2", to: "leader", timestamp: Date.now(), payload: { reason: "r" } }];
    markReadResult = 1;

    await teamHandler({ source: "cli", args: ["inbox"] });
    readUnreadMessages = [];
    const empty = await teamHandler({ source: "cli", args: ["inbox", "lead", "--mark-read"] });
    expect(empty.ok).toBe(true);
    const marked = await teamHandler({ source: "cli", args: ["inbox", "lead", "--mark-read"] });
    expect(marked.ok).toBe(true);
  });

  test("recover handles missing and active snapshots", async () => {
    const noSnap = await teamHandler({ source: "cli", args: ["recover", "env-team"] });
    expect(noSnap.error).toBe("no snapshot");

    snapshot = {
      teamName: "env-team",
      leaderPane: "L1",
      layout: "main-vertical",
      savedAt: Date.now() - 120_000,
      panes: [
        { agentId: "a1", tmuxPaneId: "P1", color: "green", name: "n1" },
        { agentId: "a2", tmuxPaneId: "P3", color: "blue", name: "n2" },
      ],
    };
    hostExecMap["tmux list-panes -a -F '#{pane_id}'"] = "P1\nP2";
    const ok = await teamHandler({ source: "cli", args: ["recover", "env-team"] });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("1 dead");
  });

  test("unknown subcommand returns usage", async () => {
    const res = await teamHandler({ source: "cli", args: ["mystery"] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown subcommand: mystery");
  });
});
