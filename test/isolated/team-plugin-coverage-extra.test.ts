import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

type TeamMember = {
  name: string;
  agentId?: string;
  agentType?: string;
  tmuxPaneId?: string;
  color?: string;
};

type TeamConfig = {
  name: string;
  members: TeamMember[];
};

const original = {
  cwd: process.cwd(),
  home: process.env.HOME,
  mawTeam: process.env.MAW_TEAM,
  tmux: process.env.TMUX,
  tmuxPane: process.env.TMUX_PANE,
  claudeSessionId: process.env.CLAUDE_SESSION_ID,
};

const roots: string[] = [];

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
  loadTeam: [],
  hostExec: [],
  colorAnsi: [],
  getWindowTarget: [],
  applyTeamLayout: [],
  applyTiledLayout: [],
  stylePaneBorder: [],
  enableBorderStatus: [],
  loadLayoutSnapshot: [],
  readUnread: [],
  readInbox: [],
  markRead: [],
};

const vendorCalls: Record<string, unknown[][]> = {
  listPaneIds: [],
  listPanes: [],
  findZombiePanes: [],
};

let commandTeam: TeamConfig | undefined;
let commandTeamsDir = "";
let commandHostExecQueue: Array<string | Error> = [];
let inboxMessages: Array<{
  timestamp: string;
  type: string;
  from: string;
  payload: Record<string, unknown>;
}> = [];
let markedMessages = 0;
let layoutSnapshot: undefined | {
  savedAt: number;
  leaderPane: string;
  panes: Array<{ tmuxPaneId: string; name: string; agentId: string; color: string }>;
};

let vendorPaneIds = new Set<string>();
let vendorPanes: unknown[] = [];
let vendorZombies: unknown[] = [];

function resetCallRecord(record: Record<string, unknown[][]>) {
  for (const key of Object.keys(record)) record[key] = [];
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function parseFlagsMock(args: string[], schema: Record<string, unknown>, startIndex = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { _: [] as string[] };
  for (let i = startIndex; i < args.length; i++) {
    const token = args[i]!;
    if (token in schema) {
      const parser = schema[token];
      if (parser === Boolean) {
        out[token] = true;
      } else if (parser === Number) {
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
}

async function hostExecMock(cmd: string): Promise<string> {
  commandCalls.hostExec.push([cmd]);
  const next = commandHostExecQueue.shift();
  if (next instanceof Error) throw next;
  return next ?? "";
}

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return logs;
}

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => commandCalls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => commandCalls.cmdTeamSpawn.push(args),
  cmdTeamSend: (...args: unknown[]) => commandCalls.cmdTeamSend.push(args),
  cmdTeamResume: (...args: unknown[]) => commandCalls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => commandCalls.cmdTeamLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => commandCalls.cmdTeamShutdown.push(args),
  cmdTeamList: async (...args: unknown[]) => commandCalls.cmdTeamList.push(args),
}));

mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => commandCalls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => commandCalls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => commandCalls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => commandCalls.cmdTeamTaskAssign.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-status"), () => ({
  cmdTeamStatus: async (...args: unknown[]) => commandCalls.cmdTeamStatus.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-cleanup"), () => ({
  cmdTeamDelete: async (...args: unknown[]) => commandCalls.cmdTeamDelete.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-invite"), () => ({
  cmdTeamInvite: async (...args: unknown[]) => commandCalls.cmdTeamInvite.push(args),
}));

mock.module(at("../../src/commands/plugins/team/oracle-members"), () => ({
  cmdOracleInvite: (...args: unknown[]) => commandCalls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => commandCalls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => commandCalls.cmdOracleMembers.push(args),
}));

mock.module(at("../../src/commands/plugins/team/team-helpers"), () => ({
  get TEAMS_DIR() {
    return commandTeamsDir;
  },
  loadTeam: (name: string) => {
    commandCalls.loadTeam.push([name]);
    return commandTeam;
  },
}));

mock.module(at("../../src/commands/plugins/split/impl"), () => ({
  cmdSplit: async (...args: unknown[]) => commandCalls.cmdSplit.push(args),
}));

mock.module(at("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxPeek: async (...args: unknown[]) => commandCalls.cmdTmuxPeek.push(args),
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (index: number) => ["red", "green", "blue"][index % 3],
  colorAnsi: (...args: unknown[]) => {
    commandCalls.colorAnsi.push(args);
    return "31";
  },
  stylePaneBorder: async (...args: unknown[]) => commandCalls.stylePaneBorder.push(args),
  enableBorderStatus: async (...args: unknown[]) => commandCalls.enableBorderStatus.push(args),
  applyTeamLayout: async (...args: unknown[]) => commandCalls.applyTeamLayout.push(args),
  applyTiledLayout: async (...args: unknown[]) => commandCalls.applyTiledLayout.push(args),
  getWindowTarget: async (...args: unknown[]) => {
    commandCalls.getWindowTarget.push(args);
    return "window-0";
  },
}));

mock.module(at("../../src/commands/plugins/team/layout-snapshot"), () => ({
  loadLayoutSnapshot: (...args: unknown[]) => {
    commandCalls.loadLayoutSnapshot.push(args);
    return layoutSnapshot;
  },
}));

mock.module(at("../../src/commands/plugins/team/inbox"), () => ({
  readUnread: (...args: unknown[]) => {
    commandCalls.readUnread.push(args);
    return inboxMessages;
  },
  readInbox: (...args: unknown[]) => {
    commandCalls.readInbox.push(args);
    return inboxMessages;
  },
  markRead: (...args: unknown[]) => {
    commandCalls.markRead.push(args);
    return markedMessages;
  },
}));

mock.module(at("../../src/cli/parse-args"), () => ({
  parseFlags: parseFlagsMock,
}));

mock.module(at("../../src/sdk"), () => ({
  hostExec: hostExecMock,
  withPaneLock: async (fn: () => Promise<void>) => fn(),
}));

mock.module("maw-js/sdk", () => ({
  hostExec: hostExecMock,
  tmux: {
    listPaneIds: async (...args: unknown[]) => {
      vendorCalls.listPaneIds.push(args);
      return vendorPaneIds;
    },
    listPanes: async (...args: unknown[]) => {
      vendorCalls.listPanes.push(args);
      return vendorPanes;
    },
  },
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-lifecycle"), () => ({
  cmdTeamShutdown: async () => {},
  cmdTeamCreate: () => {},
  cmdTeamSpawn: async () => {},
  mergeTeamKnowledge: () => {},
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-comms"), () => ({
  cmdTeamSend: () => {},
  cmdTeamBroadcast: async () => {},
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-workspace"), () => ({
  cmdTeamBring: async () => [],
  resolveTeamBringSession: async () => "session",
  teamOracleMemberNames: () => [],
  loadTeamOracleMemberNames: () => [],
  applyTeamBringLayout: async () => "main-vertical",
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-reincarnation"), () => ({
  cmdTeamResume: () => {},
  cmdTeamLives: () => {},
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-charter"), () => ({
  parseTeamCharterText: () => ({ name: "mock", members: [] }),
  readTeamCharter: () => ({ name: "mock", members: [] }),
  planTeamCharter: () => ({ artifacts: [], actions: [], warnings: [] }),
  formatTeamCharterPlan: () => "",
  preflightTeamCharter: () => ({ errors: [], warnings: [], checks: [], actions: [] }),
  formatTeamCharterPreflight: () => "",
  loadTeamCharter: () => ({ plan: {}, writtenArtifacts: [], actions: [] }),
  formatTeamCharterLoad: () => "",
  composeTeamCharterMemberPrompt: () => "",
  spawnFromTeamCharter: async () => ({ charter: {}, spawnedRoles: [], actions: [] }),
  formatTeamCharterSpawn: () => "",
}));

mock.module(at("../../src/vendor/mpr-plugins/team/team-cleanup-zombies"), () => ({
  cmdCleanupZombies: async () => {},
  findZombiePanes: (...args: unknown[]) => {
    vendorCalls.findZombiePanes.push(args);
    return vendorZombies;
  },
}));

const { default: teamHandler } = await import("../../src/commands/plugins/team/index");
const vendorHelpers = await import("../../src/vendor/mpr-plugins/team/team-helpers");
const vendorImpl = await import("../../src/vendor/mpr-plugins/team/impl");

beforeEach(() => {
  resetCallRecord(commandCalls);
  resetCallRecord(vendorCalls);

  commandTeam = undefined;
  commandHostExecQueue = [];
  inboxMessages = [];
  markedMessages = 0;
  layoutSnapshot = undefined;
  commandTeamsDir = tempRoot("maw-command-teams-");

  vendorPaneIds = new Set<string>();
  vendorPanes = [];
  vendorZombies = [];

  process.chdir(original.cwd);
  if (original.home === undefined) delete process.env.HOME;
  else process.env.HOME = original.home;
  process.env.MAW_TEAM = "env-team";
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  process.chdir(original.cwd);
  if (original.home === undefined) delete process.env.HOME;
  else process.env.HOME = original.home;
  if (original.mawTeam === undefined) delete process.env.MAW_TEAM;
  else process.env.MAW_TEAM = original.mawTeam;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
  if (original.tmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = original.tmuxPane;
  if (original.claudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = original.claudeSessionId;

  while (roots.length > 0) {
    const root = roots.pop()!;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe("src/commands/plugins/team/index extra branch coverage", () => {
  test("dispatches direct lifecycle subcommands with parsed options and aliases", async () => {
    await teamHandler({ source: "cli", args: ["new", "alpha", "--description", "field", "ops"] });
    await teamHandler({ source: "cli", args: ["spawn", "alpha", "builder", "--model", "opus", "--worktree", "/tmp/wt", "--prompt", "Review", "--exec", "--cwd", "/tmp/cwd", "now"] });
    await teamHandler({ source: "cli", args: ["msg", "alpha", "scout", "hello", "team"] });
    await teamHandler({ source: "cli", args: ["resume", "alpha", "--model", "haiku"] });
    await teamHandler({ source: "cli", args: ["history", "scout"] });
    await teamHandler({ source: "cli", args: ["down", "alpha", "--force", "--merge"] });
    await teamHandler({ source: "cli", args: [] });

    expect(commandCalls.cmdTeamCreate).toEqual([["alpha", { description: "field ops" }]]);
    expect(commandCalls.cmdTeamSpawn).toEqual([["alpha", "builder", {
      model: "opus",
      prompt: "Review now",
      exec: true,
      cwd: "/tmp/cwd",
    }]]);
    expect(commandCalls.cmdTeamSend).toEqual([["alpha", "scout", "hello team"]]);
    expect(commandCalls.cmdTeamResume).toEqual([["alpha", { model: "haiku" }]]);
    expect(commandCalls.cmdTeamLives).toEqual([["scout"]]);
    expect(commandCalls.cmdTeamShutdown).toEqual([["alpha", { force: true, merge: true }]]);
    expect(commandCalls.cmdTeamList).toEqual([[]]);
  });

  test("dispatches task, status, cleanup, invite, oracle, split, and peek paths", async () => {
    await teamHandler({ source: "cli", args: ["task", "ship", "coverage", "--team", "explicit", "--assign", "scout", "--description", "branch sweep"] });
    await teamHandler({ source: "cli", args: ["done", "42"] });
    await teamHandler({ source: "cli", args: ["assign", "7", "builder", "--team", "ops"] });
    await teamHandler({ source: "cli", args: ["status", "ops"] });
    await teamHandler({ source: "cli", args: ["rm", "ops"] });
    await teamHandler({ source: "cli", args: ["invite", "ops", "peer", "--scope", "narrow", "--lead", "nat"] });
    await teamHandler({ source: "cli", args: ["oracle-invite", "oracle-a", "--role", "reviewer"] });
    await teamHandler({ source: "cli", args: ["oracle-remove", "oracle-a", "--team", "ops"] });
    await teamHandler({ source: "cli", args: ["open", "agent-a", "--pct", "44", "--vertical"] });
    await teamHandler({ source: "cli", args: ["peek", "agent-a"] });

    expect(commandCalls.cmdTeamTaskAdd).toEqual([["explicit", "ship coverage", { assign: "scout", description: "branch sweep" }]]);
    expect(commandCalls.cmdTeamTaskDone).toEqual([["env-team", 42]]);
    expect(commandCalls.cmdTeamTaskAssign).toEqual([["ops", 7, "builder"]]);
    expect(commandCalls.cmdTeamStatus).toEqual([["ops"]]);
    expect(commandCalls.cmdTeamDelete).toEqual([["ops"]]);
    expect(commandCalls.cmdTeamInvite).toEqual([["ops", "peer", { scope: "narrow", lead: "nat" }]]);
    expect(commandCalls.cmdOracleInvite).toEqual([["env-team", "oracle-a", { role: "reviewer" }]]);
    expect(commandCalls.cmdOracleRemove).toEqual([["ops", "oracle-a"]]);
    expect(commandCalls.cmdSplit).toEqual([["agent-a", { pct: 44, vertical: true, lock: true }]]);
    expect(commandCalls.cmdTmuxPeek).toEqual([["agent-a"]]);
  });

  test("falls back to the default team when MAW_TEAM is absent and context is ambiguous", async () => {
    delete process.env.MAW_TEAM;

    await teamHandler({ source: "cli", args: ["tasks"] });

    expect(commandCalls.cmdTeamTaskList).toEqual([["default"]]);
  });

  test("close handles single-pane and multi-pane tmux sessions", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%0";
    commandHostExecQueue = ["%0"];
    const single = await teamHandler({ source: "cli", args: ["close"] });
    expect(single.ok).toBe(true);
    expect(commandCalls.hostExec).toEqual([["tmux list-panes -F '#{pane_id}'"]]);

    resetCallRecord(commandCalls);
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%0";
    commandHostExecQueue = ["%0\n%1\n%2"];
    const multi = await teamHandler({ source: "cli", args: ["close"] });

    expect(multi.ok).toBe(true);
    expect(commandCalls.hostExec).toEqual([
      ["tmux list-panes -F '#{pane_id}'"],
      ["tmux kill-pane -t '%1'"],
      ["tmux kill-pane -t '%2'"],
    ]);
    expect(stripAnsi(multi.output ?? "")).toContain("closed 2 panes");
  });

  test("broadcast sends to non-lead panes and reports partial send failures", async () => {
    commandTeam = {
      name: "env-team",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "scout", agentId: "scout@env-team", tmuxPaneId: "%1", color: "red" },
        { name: "reviewer", agentId: "reviewer@env-team", tmuxPaneId: "%2" },
        { name: "offline" },
      ],
    };
    commandHostExecQueue = ["", new Error("pane died")];

    const result = await teamHandler({ source: "cli", args: ["broadcast", "it's", "ok"] });

    expect(result.ok).toBe(true);
    expect(commandCalls.hostExec).toEqual([
      ["tmux send-keys -t '%1' 'it'\\''s ok' Enter"],
      ["tmux send-keys -t '%2' 'it'\\''s ok' Enter"],
    ]);
    expect(stripAnsi(result.output ?? "")).toContain("broadcast to 1/2 agents: it's ok");
  });

  test("enter and hey handle matching, unavailable agents, and escaped messages", async () => {
    commandTeam = {
      name: "env-team",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "scout", agentId: "scout@env-team", tmuxPaneId: "%1", color: "red" },
        { name: "reviewer", agentId: "reviewer@env-team", tmuxPaneId: "%2" },
      ],
    };

    const enterAll = await teamHandler({ source: "cli", args: ["enter", "all"] });
    expect(enterAll.ok).toBe(true);
    expect(commandCalls.hostExec).toEqual([
      ["tmux send-keys -t '%1' Enter"],
      ["tmux send-keys -t '%2' Enter"],
    ]);

    resetCallRecord(commandCalls);
    const missing = await teamHandler({ source: "cli", args: ["enter", "ghost"] });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("agent not found");
    expect(commandCalls.loadTeam).toEqual([["env-team"]]);

    resetCallRecord(commandCalls);
    const hey = await teamHandler({ source: "cli", args: ["hey", "scout", "don't", "stop"] });
    expect(hey.ok).toBe(true);
    expect(commandCalls.hostExec).toEqual([
      ["tmux send-keys -t '%1' 'don'\\''t stop' Enter"],
    ]);
    expect(stripAnsi(hey.output ?? "")).toContain("sent to scout@env-team: don't stop");
  });

  test("layout, inbox, recover, and unknown branches return focused results", async () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%leader";

    const main = await teamHandler({ source: "cli", args: ["layout", "main-vertical", "--pct", "45"] });
    const tiled = await teamHandler({ source: "cli", args: ["layout", "tiled"] });

    expect(main.ok).toBe(true);
    expect(tiled.ok).toBe(true);
    expect(commandCalls.applyTeamLayout).toContainEqual(["window-0", "%leader", 45]);
    expect(commandCalls.applyTiledLayout).toEqual([["window-0"]]);

    inboxMessages = [{
      timestamp: "2026-05-18T00:00:00.000Z",
      type: "done",
      from: "scout",
      payload: { subject: "coverage pass finished" },
    }];
    markedMessages = 1;
    const inbox = await teamHandler({ source: "cli", args: ["inbox", "scout", "--mark-read"] });
    expect(inbox.ok).toBe(true);
    expect(commandCalls.readInbox).toEqual([["env-team", "scout"]]);
    expect(commandCalls.markRead).toEqual([["env-team", "scout"]]);
    expect(stripAnsi(inbox.output ?? "")).toContain("marked 1 message read");

    commandHostExecQueue = ["%alive\n"];
    layoutSnapshot = {
      savedAt: Date.now() - 120_000,
      leaderPane: "%snap-leader",
      panes: [
        { tmuxPaneId: "%alive", name: "scout", agentId: "scout@env-team", color: "red" },
        { tmuxPaneId: "%dead", name: "reviewer", agentId: "reviewer@env-team", color: "blue" },
      ],
    };
    const recover = await teamHandler({ source: "cli", args: ["recover", "env-team"] });
    expect(recover.ok).toBe(true);
    expect(commandCalls.stylePaneBorder).toEqual([["%alive", "scout", "red"]]);
    expect(stripAnsi(recover.output ?? "")).toContain("recovered 1 pane, 1 dead");

    layoutSnapshot = undefined;
    const missingSnapshot = await teamHandler({ source: "cli", args: ["recover", "ghost"] });
    expect(missingSnapshot.ok).toBe(false);
    expect(missingSnapshot.error).toBe("no snapshot");

    const unknown = await teamHandler({ source: "cli", args: ["wat"] });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toBe("unknown subcommand: wat");
  });
});

describe("src/vendor/mpr-plugins/team/impl cmdTeamList coverage", () => {
  test("reports empty stores without asking tmux for pane state", async () => {
    const root = tempRoot("maw-vendor-empty-");
    process.chdir(root);
    vendorHelpers._setDirs(join(root, "tool-teams"), join(root, "tasks"));

    const logs = await captureLogs(() => vendorImpl.cmdTeamList());
    const output = stripAnsi(logs.join("\n"));

    expect(output).toContain("No teams found.");
    expect(output).toContain("looked in: ~/.claude/teams/ (tool) + ψ/memory/mailbox/teams/ (vault)");
    expect(vendorCalls.listPaneIds).toHaveLength(0);
    expect(vendorCalls.listPanes).toHaveLength(0);
  });

  test("lists tool teams, vault-only manifests, skipped malformed entries, and zombies", async () => {
    const root = tempRoot("maw-vendor-list-");
    process.chdir(root);
    process.env.CLAUDE_SESSION_ID = "current-lead";
    const teamsDir = join(root, "tool-teams");
    vendorHelpers._setDirs(teamsDir, join(root, "tasks"));

    mkdirSync(join(root, "ψ/memory/mailbox/teams"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "oracle root\n");

    writeJson(join(teamsDir, "alpha/config.json"), {
      name: "alpha",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "scout", tmuxPaneId: "%1" },
        { name: "reviewer", tmuxPaneId: "%dead" },
      ],
    });
    writeJson(join(teamsDir, "orphan/config.json"), {
      name: "orphan",
      leadSessionId: "previous-lead",
      members: [{ name: "scout", tmuxPaneId: "" }],
    });
    writeJson(join(teamsDir, "quiet/config.json"), {
      name: "quiet",
      members: [{ name: "builder", tmuxPaneId: "" }],
    });
    mkdirSync(join(teamsDir, "broken"), { recursive: true });
    writeFileSync(join(teamsDir, "broken/config.json"), "{ nope");

    writeJson(join(root, "ψ/memory/mailbox/teams/vault-only/manifest.json"), {
      members: ["archivist", { name: "scribe" }, { missing: true }],
    });
    writeJson(join(root, "ψ/memory/mailbox/teams/alpha/manifest.json"), {
      members: ["duplicate should be skipped"],
    });
    mkdirSync(join(root, "ψ/memory/mailbox/teams/no-manifest"), { recursive: true });
    mkdirSync(join(root, "ψ/memory/mailbox/teams/malformed"), { recursive: true });
    writeFileSync(join(root, "ψ/memory/mailbox/teams/malformed/manifest.json"), "{ nope");

    vendorPaneIds = new Set(["%0", "%1"]);
    vendorPanes = [{ paneId: "%z", command: "claude" }];
    vendorZombies = [{ paneId: "%z", info: "claude", teamName: "deleted" }];

    const logs = await captureLogs(() => vendorImpl.cmdTeamList());
    const output = stripAnsi(logs.join("\n"));

    expect(output).toContain("TEAM");
    expect(output).toContain("alpha");
    expect(output).toContain("tool");
    expect(output).toContain("1 alive");
    expect(output).toContain("1 exited");
    expect(output).toContain("orphaned (lead dead)");
    expect(output).toContain("quiet");
    expect(output).toContain("no live panes");
    expect(output).toContain("vault-only");
    expect(output).toContain("vault");
    expect(output).toContain("prep-only");
    expect(output).toContain("1 vault-only team(s)");
    expect(output).toContain("1 orphan zombie pane(s) detected");
    expect(output).not.toContain("duplicate should be skipped");
    expect(output).not.toContain("malformed");
    expect(vendorCalls.listPaneIds).toEqual([[]]);
    expect(vendorCalls.listPanes).toEqual([[]]);
    expect(vendorCalls.findZombiePanes).toEqual([[vendorPanes]]);
  });
});
