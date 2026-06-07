import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
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

type OracleRegistry = {
  members: Array<{ oracle?: string | null; role?: string; addedAt?: string }>;
};

type InboxMessage = {
  type: "done" | "stuck" | "progress" | "status" | "shutdown";
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-home-"));
let commandTeamsDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-teams-"));
let psiDir = mkdtempSync(join(tmpdir(), "maw-team-comms-extra-psi-"));
const originalPath = process.env.PATH ?? "";

const commandCalls: Record<string, unknown[][]> = {
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
};

const vendorCalls: Record<string, unknown[][]> = {
  loadOracleRegistry: [],
  loadTeam: [],
  writeMessage: [],
  cmdSend: [],
};

let commandLoadTeamResult: Team | undefined;
let commandHostExecQueue: Array<string | Error> = [];
let commandTaskListLogsError = false;
let commandThrowOnResume = false;
let readUnreadMessages: InboxMessage[] = [];
let readInboxMessages: InboxMessage[] = [];
let markReadResult = 0;
let layoutSnapshot: any = null;
let childExecSyncResult: string | Error = "";

let vendorRegistry: OracleRegistry | undefined;
let vendorLoadTeamResult: Team | undefined;
let sendBehaviors: Record<string, "ok" | "throw" | "exit-caught" | "exit-uncaught"> = {};

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module("child_process", () => ({
  execSync: () => {
    if (childExecSyncResult instanceof Error) throw childExecSyncResult;
    return childExecSyncResult;
  },
}));

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => commandCalls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => { commandCalls.cmdTeamSpawn.push(args); },
  cmdTeamSend: (...args: unknown[]) => commandCalls.cmdTeamSend.push(args),
  cmdTeamResume: (...args: unknown[]) => {
    if (commandThrowOnResume) throw new Error("resume exploded");
    commandCalls.cmdTeamResume.push(args);
  },
  cmdTeamLives: (...args: unknown[]) => commandCalls.cmdTeamLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => { commandCalls.cmdTeamShutdown.push(args); },
  cmdTeamList: () => commandCalls.cmdTeamList.push([]),
}));

mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => commandCalls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => {
    commandCalls.cmdTeamTaskList.push(args);
    if (commandTaskListLogsError) console.error("task-list", String(args[0]));
  },
  cmdTeamTaskDone: (...args: unknown[]) => commandCalls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => commandCalls.cmdTeamTaskAssign.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-status"), () => ({
  cmdTeamStatus: async (...args: unknown[]) => { commandCalls.cmdTeamStatus.push(args); },
}));

mock.module(at("../../src/commands/plugins/team/team-cleanup"), () => ({
  cmdTeamDelete: async (...args: unknown[]) => { commandCalls.cmdTeamDelete.push(args); },
}));

mock.module(at("../../src/commands/plugins/team/team-invite"), () => ({
  cmdTeamInvite: async (...args: unknown[]) => { commandCalls.cmdTeamInvite.push(args); },
}));

mock.module(at("../../src/commands/plugins/team/oracle-members"), () => ({
  cmdOracleInvite: (...args: unknown[]) => commandCalls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => commandCalls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => commandCalls.cmdOracleMembers.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-helpers"), () => ({
  TEAMS_DIR: commandTeamsDir,
  loadTeam: () => commandLoadTeamResult,
}));

mock.module(at("../../src/commands/plugins/split/impl"), () => ({
  cmdSplit: (...args: unknown[]) => commandCalls.cmdSplit.push(args),
}));

mock.module(at("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxPeek: async (...args: unknown[]) => { commandCalls.cmdTmuxPeek.push(args); },
}));

mock.module(at("../../src/cli/parse-args"), () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    for (let i = startIndex; i < args.length; i++) {
      const token = args[i] ?? "";
      if (token in schema) {
        const valueType = schema[token];
        if (valueType === Boolean) out[token] = true;
        else if (valueType === Number) {
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
    commandCalls.hostExec.push([cmd]);
    const next = commandHostExecQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  withPaneLock: async (fn: () => Promise<void>) => {
    commandCalls.withPaneLock.push([]);
    return fn();
  },
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (i: number) => ["red", "green", "blue"][i] ?? "white",
  colorAnsi: (color: string) => ({ red: "31", green: "32", blue: "34", white: "37" } as Record<string, string>)[color] ?? "35",
  stylePaneBorder: async (...args: unknown[]) => { commandCalls.stylePaneBorder.push(args); },
  enableBorderStatus: async (...args: unknown[]) => { commandCalls.enableBorderStatus.push(args); },
  applyTeamLayout: async (...args: unknown[]) => { commandCalls.applyTeamLayout.push(args); },
  applyTiledLayout: async (...args: unknown[]) => { commandCalls.applyTiledLayout.push(args); },
  getWindowTarget: async () => "win:1",
}));

mock.module(at("../../src/commands/plugins/team/inbox"), () => ({
  readUnread: () => readUnreadMessages,
  readInbox: () => readInboxMessages,
  markRead: () => markReadResult,
}));

mock.module(at("../../src/commands/plugins/team/layout-snapshot"), () => ({
  loadLayoutSnapshot: () => layoutSnapshot,
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-helpers"), () => ({
  loadTeam: (teamName: string) => {
    vendorCalls.loadTeam.push([teamName]);
    return vendorLoadTeamResult;
  },
  writeMessage: (...args: unknown[]) => vendorCalls.writeMessage.push(args),
  resolvePsi: () => psiDir,
}));

mock.module(at("../../src/vendor/mpr-plugins/team/oracle-members"), () => ({
  loadOracleRegistry: (teamName: string) => {
    vendorCalls.loadOracleRegistry.push([teamName]);
    return vendorRegistry;
  },
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  cmdSend: async (target: string, message: string, interactive: boolean) => {
    vendorCalls.cmdSend.push([target, message, interactive]);
    const behavior = sendBehaviors[target] ?? "ok";
    if (behavior === "throw") throw new Error("send boom");
    if (behavior === "exit-caught") {
      try { process.exit(7); } catch { /* cmdSend swallowed process.exit */ }
      return;
    }
    if (behavior === "exit-uncaught") process.exit(8);
  },
}));

const { default: teamHandler } = await import("../../src/commands/plugins/team/index");
const {
  cmdTeamBroadcast,
  cmdTeamSend,
  resolveTeamSendMode,
  teamMessageTargets,
} = await import("../../src/vendor/mpr-plugins/team/team-comms");

function resetCalls() {
  for (const key of Object.keys(commandCalls)) commandCalls[key] = [];
  for (const key of Object.keys(vendorCalls)) vendorCalls[key] = [];
}

function resetEnv() {
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.PATH = originalPath;
}

function resetState() {
  resetCalls();
  resetEnv();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(commandTeamsDir, { recursive: true, force: true });
  rmSync(psiDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-home-"));
  commandTeamsDir = mkdtempSync(join(tmpdir(), "maw-team-index-extra-teams-"));
  psiDir = mkdtempSync(join(tmpdir(), "maw-team-comms-extra-psi-"));
  commandLoadTeamResult = undefined;
  commandHostExecQueue = [];
  commandTaskListLogsError = false;
  commandThrowOnResume = false;
  readUnreadMessages = [];
  readInboxMessages = [];
  markReadResult = 0;
  layoutSnapshot = null;
  childExecSyncResult = "";
  vendorRegistry = undefined;
  vendorLoadTeamResult = undefined;
  sendBehaviors = {};
}

function writeHomeTeamConfig(teamName: string) {
  const teamDir = join(homeDir, ".claude", "teams", teamName);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({ name: teamName, members: [] }));
}

function writeCommandTeamConfig(teamName: string, config: Record<string, unknown>) {
  const teamDir = join(commandTeamsDir, teamName);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify(config, null, 2));
  return join(teamDir, "config.json");
}

function installFakeTmux(sessionName: string) {
  const binDir = join(homeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const tmuxPath = join(binDir, "tmux");
  writeFileSync(tmuxPath, `#!/bin/sh\nprintf '%s\\n' '${sessionName}'\n`);
  chmodSync(tmuxPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;
}

async function captureConsole<T>(fn: () => T | Promise<T>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const value = await fn();
    return { value, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetEnv();
});

describe("vendor team comms extra isolated coverage", () => {
  test("teamMessageTargets merges durable oracle members with live non-lead members", () => {
    vendorRegistry = {
      members: [
        { oracle: "durable-a" },
        { oracle: "shared" },
        { oracle: "" },
        { oracle: null },
      ],
    };
    vendorLoadTeamResult = {
      name: "room",
      members: [
        { name: "lead", agentType: "team-lead" },
        { name: "shared" },
        { name: "live-b" },
      ],
    };

    expect(teamMessageTargets("room")).toEqual(["durable-a", "shared", "live-b"]);
    expect(vendorCalls.loadOracleRegistry).toEqual([["room"]]);
    expect(vendorCalls.loadTeam).toEqual([["room"]]);
  });

  test("teamMessageTargets returns an empty list when neither registry nor live team exists", () => {
    expect(teamMessageTargets("empty-room")).toEqual([]);
    expect(vendorCalls.loadOracleRegistry).toEqual([["empty-room"]]);
    expect(vendorCalls.loadTeam).toEqual([["empty-room"]]);
  });

  test("resolveTeamSendMode covers usage, quoted broadcast, legacy single, and unquoted broadcast", () => {
    expect(() => resolveTeamSendMode([], ["one"])).toThrow("usage: maw team send <team> <message>");
    expect(resolveTeamSendMode(["hello team"], ["one"])).toEqual({ mode: "broadcast", message: "hello team" });
    expect(resolveTeamSendMode(["one", "hello", "there"], ["one", "two"])).toEqual({
      mode: "single",
      agent: "one",
      message: "hello there",
    });
    expect(resolveTeamSendMode(["ghost", "legacy"], [])).toEqual({
      mode: "single",
      agent: "ghost",
      message: "legacy",
    });
    expect(resolveTeamSendMode(["hello", "whole", "team"], ["one"])).toEqual({
      mode: "broadcast",
      message: "hello whole team",
    });
  });

  test("cmdTeamSend validates message, writes live-team inbox, and falls back to psi mailbox", async () => {
    expect(() => cmdTeamSend("room", "agent-a", "")).toThrow("usage: maw team send <team> <agent> <message>");

    vendorLoadTeamResult = { name: "room", members: [{ name: "agent-a" }] };
    const live = await captureConsole(() => cmdTeamSend("room", "agent-a", "hello live"));
    expect(vendorCalls.writeMessage).toEqual([["room", "agent-a", "maw-team-send", "hello live"]]);
    expect(stripAnsi(live.logs.join("\n"))).toContain("message sent to agent-a in live team 'room'");

    vendorLoadTeamResult = undefined;
    vendorCalls.writeMessage = [];
    const fallback = await captureConsole(() => cmdTeamSend("async-room", "agent-b", "hello async"));
    const mailboxDir = join(psiDir, "memory", "mailbox", "agent-b");
    expect(existsSync(mailboxDir)).toBe(true);
    const files = readdirSync(mailboxDir);
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(join(mailboxDir, files[0]!), "utf-8"));
    expect(payload).toMatchObject({ from: "maw-team-send", team: "async-room", text: "hello async" });
    expect(typeof payload.timestamp).toBe("string");
    expect(stripAnsi(fallback.logs.join("\n"))).toContain("message written to ψ/memory/mailbox/agent-b/");
    expect(vendorCalls.writeMessage).toHaveLength(0);
  });

  test("cmdTeamBroadcast validates input, rejects empty teams, delivers success, and restores process.exit", async () => {
    await expect(cmdTeamBroadcast("room", "")).rejects.toThrow("usage: maw team send <team> <message>");
    await expect(cmdTeamBroadcast("room", "hello nobody")).rejects.toThrow("no members in team 'room'");

    vendorRegistry = { members: [{ oracle: "durable-a" }, { oracle: "durable-b" }] };
    const origExit = process.exit;
    const delivered = await captureConsole(() => cmdTeamBroadcast("room", "hello everyone"));

    expect(process.exit).toBe(origExit);
    expect(vendorCalls.cmdSend).toEqual([
      ["durable-a", "hello everyone", false],
      ["durable-b", "hello everyone", false],
    ]);
    expect(stripAnsi(delivered.logs.join("\n"))).toContain("broadcast delivered to 2 member(s)");
  });

  test("cmdTeamBroadcast treats swallowed process.exit and thrown sends as partial failures", async () => {
    vendorRegistry = { members: [{ oracle: "exit-agent" }, { oracle: "throw-agent" }] };
    sendBehaviors = { "exit-agent": "exit-caught", "throw-agent": "throw" };
    const origExit = process.exit;

    const captured = await captureConsole(async () => {
      await expect(cmdTeamBroadcast("room", "check in")).rejects.toThrow("broadcast partial failure: 0 delivered, 2 failed");
    });

    expect(process.exit).toBe(origExit);
    expect(vendorCalls.cmdSend).toContainEqual(["exit-agent", "check in", false]);
    expect(stripAnsi(captured.errors.join("\n"))).toContain("throw-agent: send boom");
  });
});
