import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const calls: Record<string, unknown[]> = {
  cmdTeamCreate: [],
  cmdTeamSpawn: [],
  cmdTeamList: [],
  cmdTeamSend: [],
  cmdTeamBroadcast: [],
  cmdTeamBring: [],
  cmdTeamShutdown: [],
  cmdTeamResume: [],
  cmdTeamLives: [],
  cmdTeamTaskAdd: [],
  cmdTeamTaskList: [],
  cmdTeamTaskDone: [],
  cmdTeamTaskAssign: [],
  cmdOracleInvite: [],
  cmdOracleRemove: [],
  cmdOracleMembers: [],
  loadTeam: [],
  hostExec: [],
};

type TeamMember = {
  name: string;
  agentId?: string;
  agentType?: string;
  tmuxPaneId?: string;
};

type Team = {
  name: string;
  members: TeamMember[];
};

let homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-second-pass-"));
let loadTeamResult: Team | undefined;
const originalSpawnSync = Bun.spawnSync;

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => {
    calls.hostExec.push(cmd);
    return "";
  },
  tmux: {
    listPaneIds: async () => new Set<string>(),
    listPanes: async () => [],
  },
}));

mock.module("../../src/vendor/mpr-plugins/team/impl", () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => calls.cmdTeamSpawn.push(args),
  cmdTeamList: () => calls.cmdTeamList.push([]),
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamBroadcast: async (...args: unknown[]) => calls.cmdTeamBroadcast.push(args),
  cmdTeamBring: async (...args: unknown[]) => calls.cmdTeamBring.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-comms", () => ({
  resolveTeamSendMode: (tail: string[]) => tail[0] === "one"
    ? { mode: "single", agent: tail[0], message: tail.slice(1).join(" ") }
    : { mode: "broadcast", message: tail.join(" ") },
  teamMessageTargets: (team: string) => [`${team}:one`, `${team}:two`],
}));

mock.module("../../src/vendor/mpr-plugins/team/task-ops", () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => calls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.cmdTeamTaskAssign.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/oracle-members", () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.cmdOracleMembers.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-helpers", () => ({
  loadTeam: (...args: unknown[]) => {
    calls.loadTeam.push(args);
    return loadTeamResult;
  },
}));

mock.module("../../src/vendor/mpr-plugins/team/team-charter", () => ({
  readTeamCharter: (path: string) => ({ path }),
  planTeamCharter: (charter: { path: string }) => ({ charter }),
  formatTeamCharterPlan: ({ charter }: { charter: { path: string } }) => `plan:${charter.path}`,
  preflightTeamCharter: () => ({ errors: [] as string[] }),
  formatTeamCharterPreflight: () => "preflight:ok",
  loadTeamCharter: () => ({}),
  formatTeamCharterLoad: () => "load:ok",
  spawnFromTeamCharter: async () => ({}),
  formatTeamCharterSpawn: () => "spawn:ok",
}));

const { default: teamHandler } = await import("../../src/vendor/mpr-plugins/team/index");

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
}

function resetEnv() {
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
}

function writeTeamConfig(teamName: string) {
  const teamDir = join(homeDir, ".claude", "teams", teamName);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({ name: teamName }));
}

function mockTmuxSession(sessionName: string) {
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
    stdout: Buffer.from(sessionName),
    stderr: Buffer.from(""),
    success: true,
    exitCode: 0,
  })) as typeof Bun.spawnSync;
}

beforeEach(() => {
  resetCalls();
  resetEnv();
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-second-pass-"));
  loadTeamResult = undefined;
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
});

describe("team index second-pass isolated coverage", () => {
  test("usage errors for common dispatch branches do not call helpers", async () => {
    const cases: Array<{ args: string[]; error: string; output: string }> = [
      { args: ["spawn", "team-only"], error: "team and role required", output: "usage: maw team spawn" },
      { args: ["send", "team-only"], error: "team and message required", output: "legacy single-agent inbox send" },
      { args: ["resume"], error: "name required", output: "usage: maw team resume" },
      { args: ["lives"], error: "agent name required", output: "usage: maw team lives" },
      { args: ["shutdown"], error: "name required", output: "usage: maw team shutdown" },
    ];

    for (const c of cases) {
      const result = await teamHandler({ source: "cli", args: c.args });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(c.error);
      expect(result.output).toContain(c.output);
    }

    expect(calls.cmdTeamSpawn).toHaveLength(0);
    expect(calls.cmdTeamSend).toHaveLength(0);
    expect(calls.cmdTeamBroadcast).toHaveLength(0);
    expect(calls.cmdTeamResume).toHaveLength(0);
    expect(calls.cmdTeamLives).toHaveLength(0);
    expect(calls.cmdTeamShutdown).toHaveLength(0);
  });

  test("task alias adds a task using the only configured team", async () => {
    writeTeamConfig("solo-team");

    const result = await teamHandler({
      source: "cli",
      args: ["task", "write", "coverage", "--assign", "qa", "--description", "branch coverage"],
    });

    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskAdd).toEqual([["solo-team", "write coverage", {
      assign: "qa",
      description: "branch coverage",
    }]]);
  });

  test("add reports usage when no task subject is provided", async () => {
    const result = await teamHandler({ source: "cli", args: ["add", "--team", "alpha"] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("subject required");
    expect(calls.cmdTeamTaskAdd).toHaveLength(0);
  });

  test("tasks prefers explicit team flag over positional team and context", async () => {
    process.env.MAW_TEAM = "env-team";

    const result = await teamHandler({ source: "cli", args: ["tasks", "pos-team", "--team", "flag-team"] });

    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskList).toEqual([["flag-team"]]);
  });

  test("tasks resolves team from tmux session name when matching config exists", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    writeTeamConfig("blue-team");
    mockTmuxSession("7-blue-team\n");

    const result = await teamHandler({ source: "cli", args: ["tasks"] });

    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskList).toEqual([["blue-team"]]);
  });

  test("done resolves team from environment and rejects invalid task ids", async () => {
    let result = await teamHandler({ source: "cli", args: ["done", "not-a-number"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("usage: maw team done <task-id> [--team <name>]");
    expect(calls.cmdTeamTaskDone).toHaveLength(0);

    process.env.MAW_TEAM = "env-team";
    result = await teamHandler({ source: "cli", args: ["done", "12"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskDone).toEqual([["env-team", 12]]);
  });

  test("assign falls back to default team and validates required args", async () => {
    let result = await teamHandler({ source: "cli", args: ["assign", "22"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("usage: maw team assign <task-id> <agent> [--team <name>]");
    expect(calls.cmdTeamTaskAssign).toHaveLength(0);

    result = await teamHandler({ source: "cli", args: ["assign", "22", "agent-a"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskAssign).toEqual([["default", 22, "agent-a"]]);
  });

  test("oracle member commands validate args and dispatch with context", async () => {
    let result = await teamHandler({ source: "cli", args: ["oracle-invite"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("oracle name required");
    expect(result.output).toContain("usage: maw team oracle-invite");

    result = await teamHandler({ source: "cli", args: ["oracle-invite", "sol", "--team", "flag-team", "--role", "reviewer"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdOracleInvite).toEqual([["flag-team", "sol", { role: "reviewer" }]]);

    writeTeamConfig("member-team");
    result = await teamHandler({ source: "cli", args: ["oracle-remove", "sol"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdOracleRemove).toEqual([["member-team", "sol"]]);

    result = await teamHandler({ source: "cli", args: ["members", "pos-team"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdOracleMembers).toEqual([["pos-team"]]);
  });

  test("oracle-remove reports usage when oracle name is missing", async () => {
    const result = await teamHandler({ source: "cli", args: ["oracle-remove"] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("oracle name required");
    expect(result.output).toContain("usage: maw team oracle-remove");
    expect(calls.cmdOracleRemove).toHaveLength(0);
  });

  test("enter validates an agent argument before loading a team", async () => {
    const result = await teamHandler({ source: "cli", args: ["enter"] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent required");
    expect(result.output).toContain("usage: maw team enter");
    expect(calls.loadTeam).toHaveLength(0);
  });

  test("enter reports missing team from resolved context", async () => {
    process.env.MAW_TEAM = "missing-team";

    const result = await teamHandler({ source: "cli", args: ["enter", "agent-a"] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("team not found");
    expect(result.output).toContain("team 'missing-team' not found");
    expect(calls.loadTeam).toEqual([["missing-team"]]);
  });

  test("send-enter reports available pane-backed members when target does not match", async () => {
    process.env.MAW_TEAM = "active-team";
    loadTeamResult = {
      name: "active-team",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "alice", agentId: "alice@active-team", tmuxPaneId: "%1" },
        { name: "bob", agentId: "bob@active-team" },
      ],
    };

    const result = await teamHandler({ source: "cli", args: ["send-enter", "missing"] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent not found");
    expect(result.output).toContain("agent 'missing' not found or no pane ID");
    expect(result.output).toContain("Available: lead, alice");
    expect(calls.hostExec).toHaveLength(0);
  });

  test("send-enter sends enter to a member matched by implicit agent id", async () => {
    process.env.MAW_TEAM = "active-team";
    loadTeamResult = {
      name: "active-team",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "alice", agentId: "alice@active-team", tmuxPaneId: "%1" },
        { name: "bob", agentId: "bob@active-team", tmuxPaneId: "%2" },
      ],
    };

    const result = await teamHandler({ source: "cli", args: ["send-enter", "alice"] });

    expect(result.ok).toBe(true);
    expect(calls.hostExec).toEqual(["tmux send-keys -t '%1' Enter"]);
    expect(result.output).toContain("enter sent to alice@active-team");
  });

  test("unknown subcommand returns usage and an explicit error", async () => {
    const result = await teamHandler({ source: "cli", args: ["wat"] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown subcommand: wat");
    expect(result.output).toContain("unknown team subcommand: wat");
    expect(result.output).toContain("usage: maw team <create|plan|preflight");
  });
});
