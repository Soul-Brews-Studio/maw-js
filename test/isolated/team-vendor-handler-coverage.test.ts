import { beforeEach, describe, expect, mock, test } from "bun:test";

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
  cmdTeamTaskList: [],
  cmdOracleInvite: [],
  cmdTeamInvite: [],
  cmdOracleRemove: [],
  cmdOracleMembers: [],
  cmdTeamStatus: [],
  cmdTeamDelete: [],
};

let parseFlagsReturn: Record<string, unknown> = {};

mock.module("maw-js/sdk", () => ({
  hostExec: async () => "",
  tmux: {
    listPaneIds: async () => new Set<string>(),
    listPanes: async () => [],
  },
}));

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (_args: string[], _schema: Record<string, unknown>, _start = 0) => ({
    _: [],
    ...(parseFlagsReturn || {}),
  }),
}));

mock.module("../../src/vendor/mpr-plugins/team/impl", () => ({
  cmdTeamList: () => { calls.cmdTeamList.push([]); },
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => calls.cmdTeamSpawn.push(args),
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamBroadcast: async (...args: unknown[]) => calls.cmdTeamBroadcast.push(args),
  cmdTeamBring: async (...args: unknown[]) => calls.cmdTeamBring.push(args),
  cmdTeamShutdown: (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
  cmdTeamTaskAdd: () => {},
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: () => {},
  cmdTeamTaskAssign: () => {},
  cmdTeamInvite: (...args: unknown[]) => calls.cmdTeamInvite.push(args),
  cmdTeamDelete: (...args: unknown[]) => calls.cmdTeamDelete.push(args),
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.cmdOracleMembers.push(args),
  cmdTeamStatus: (...args: unknown[]) => calls.cmdTeamStatus.push(args),
  loadTeam: () => ({ name: "vendor", members: [] }),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-charter", () => ({
  readTeamCharter: (path: string) => ({ path }),
  planTeamCharter: (c: { path: string }) => ({ charter: c.path }),
  formatTeamCharterPlan: (p: { charter: string }) => `team charter plan: ${p.charter}`,
  preflightTeamCharter: () => ({ errors: [] as string[] }),
  formatTeamCharterPreflight: (r: { errors: string[] }) => `team charter preflight: ${r.errors.length}`,
  loadTeamCharter: () => ({ path: "team.yaml" }),
  formatTeamCharterLoad: () => "team loaded",
  spawnFromTeamCharter: async () => ({ ok: true }),
  formatTeamCharterSpawn: () => "team spawn started",
}));

mock.module("../../src/vendor/mpr-plugins/team/team-comms", () => ({
  resolveTeamSendMode: (message: string[]) => {
    return message.length > 1
      ? { mode: "single", agent: message[0], message: message.slice(1).join(" ") }
      : { mode: "broadcast", message: message.join(" ") };
  },
  teamMessageTargets: () => ["agent-a", "agent-b"],
}));

mock.module("../../src/vendor/mpr-plugins/team/team-invite", () => ({
  cmdTeamInvite: async () => {},
}));

mock.module("../../src/vendor/mpr-plugins/team/oracle-members", () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.cmdOracleMembers.push(args),
}));

const { default: teamHandler } = await import("../../src/vendor/mpr-plugins/team/index");

function resetCalls() {
  for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = [];
  parseFlagsReturn = {};
}

beforeEach(() => {
  resetCalls();
});

describe("vendor team handler coverage slice", () => {
  test("create requires team name", async () => {
    const result = await teamHandler({ source: "cli", args: ["create"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("name required");
  });

  test("plan requires charter path", async () => {
    const result = await teamHandler({ source: "cli", args: ["plan"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("charter path required");
  });

  test("preflight requires charter path", async () => {
    const result = await teamHandler({ source: "cli", args: ["preflight"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("charter path required");
  });

  test("load requires --no-spawn", async () => {
    const result = await teamHandler({ source: "cli", args: ["load", "team.yaml"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("--no-spawn required");
  });

  test("spawn-from returns formatted output", async () => {
    const result = await teamHandler({ source: "cli", args: ["spawn-from", "team.yaml", "--approve", "--exec"] });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("team spawn started");
  });

  test("send dispatches single-agent form", async () => {
    await teamHandler({ source: "cli", args: ["send", "alpha", "agent-a", "hello"] });
    expect(calls.cmdTeamSend).toEqual([["alpha", "agent-a", "hello"]]);
    expect(calls.cmdTeamBroadcast).toHaveLength(0);
  });

  test("send dispatches broadcast form", async () => {
    await teamHandler({ source: "cli", args: ["send", "alpha", "hello"] });
    expect(calls.cmdTeamBroadcast).toEqual([["alpha", "hello"]]);
    expect(calls.cmdTeamSend).toHaveLength(0);
  });

  test("bring requires team", async () => {
    const result = await teamHandler({ source: "cli", args: ["bring"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team required");
  });

  test("bring forwards parsed flags", async () => {
    parseFlagsReturn = {
      _: ["team-a"],
      "--session": "sess",
      "--engine": "codex",
      "--dry-run": true,
      "--split": true,
    };
    await teamHandler({ source: "cli", args: ["bring", "team-a", "--session", "sess", "--engine", "codex", "--dry-run", "--split"] });
    expect(calls.cmdTeamBring).toEqual([["team-a", {
      session: "sess",
      engine: "codex",
      dryRun: true,
      split: true,
    }]]);
  });

  test("members uses --team flag when provided", async () => {
    parseFlagsReturn = { "--team": "explicit", _: ["ignored"] };
    await teamHandler({ source: "cli", args: ["members", "ignored", "--team", "explicit"] });
    expect(calls.cmdOracleMembers).toEqual([["explicit"]]);
  });

  test("members falls back to positional then env", async () => {
    parseFlagsReturn = { _: ["team-pos"] };
    await teamHandler({ source: "cli", args: ["members", "team-pos"] });
    expect(calls.cmdOracleMembers).toEqual([["team-pos"]]);

    resetCalls();
    parseFlagsReturn = {};
    process.env.MAW_TEAM = "env-team";
    await teamHandler({ source: "cli", args: ["members"] });
    expect(calls.cmdOracleMembers).toEqual([["env-team"]]);
  });

  test("enter errors when team is missing", async () => {
    const result = await teamHandler({ source: "cli", args: ["enter", "agent-a"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team not found");
  });
});
