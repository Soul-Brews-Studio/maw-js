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
  cmdTeamStatus: [],
  cmdTeamDelete: [],
  cmdTeamInvite: [],
  cmdOracleInvite: [],
  cmdOracleRemove: [],
  cmdOracleMembers: [],
  hostExec: [],
};

type TeamMember = { name: string; agentId?: string; agentType?: string; tmuxPaneId?: string };
type Team = { name: string; members: TeamMember[] };

let homeDir = mkdtempSync(join(tmpdir(), "maw-vendor-team-index-"));
let preflightErrors: string[] = [];
let loadTeamResult: Team | undefined;

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

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    const aliases = Object.entries(schema)
      .filter(([, value]) => typeof value === "string")
      .reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = value as string;
        return acc;
      }, {});

    for (let i = startIndex; i < args.length; i++) {
      const raw = args[i] ?? "";
      const token = aliases[raw] ?? raw;
      if (token in schema) {
        const valueType = schema[token];
        if (valueType === Boolean) {
          out[token] = true;
        } else if (valueType === Number) {
          out[token] = Number(args[i + 1] ?? 0);
          i++;
        } else {
          out[token] = args[i + 1] ?? "";
          i++;
        }
      } else {
        (out._ as string[]).push(raw);
      }
    }
    return out;
  },
}));

mock.module("../../src/vendor/mpr-plugins/team/impl", () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => calls.cmdTeamSpawn.push(args),
  cmdTeamList: () => {
    calls.cmdTeamList.push([]);
    console.log("listed teams");
  },
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamBroadcast: async (...args: unknown[]) => calls.cmdTeamBroadcast.push(args),
  cmdTeamBring: async (...args: unknown[]) => calls.cmdTeamBring.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-comms", () => ({
  resolveTeamSendMode: (tail: string[]) => tail[0] === "solo"
    ? { mode: "single", agent: tail[0], message: tail.slice(1).join(" ") }
    : { mode: "broadcast", message: tail.join(" ") },
  teamMessageTargets: (...args: unknown[]) => args,
}));

mock.module("../../src/vendor/mpr-plugins/team/team-charter", () => ({
  readTeamCharter: (path: string) => ({ path }),
  planTeamCharter: (charter: { path: string }) => ({ charter }),
  formatTeamCharterPlan: ({ charter }: { charter: { path: string } }) => `plan:${charter.path}`,
  preflightTeamCharter: () => ({ errors: preflightErrors }),
  formatTeamCharterPreflight: ({ errors }: { errors: string[] }) => `preflight:${errors.length}`,
  loadTeamCharter: (charter: { path: string }, options: Record<string, unknown>) => ({ charter, options }),
  formatTeamCharterLoad: ({ charter }: { charter: { path: string } }) => `load:${charter.path}`,
  spawnFromTeamCharter: async (_charter: { path: string }, options: Record<string, unknown>) => ({ options }),
  formatTeamCharterSpawn: ({ options }: { options: Record<string, unknown> }) => `spawn:${options.approve}:${options.exec}`,
}));

mock.module("../../src/vendor/mpr-plugins/team/task-ops", () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => calls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.cmdTeamTaskAssign.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-status", () => ({
  cmdTeamStatus: async (...args: unknown[]) => calls.cmdTeamStatus.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-cleanup", () => ({
  cmdTeamDelete: async (...args: unknown[]) => calls.cmdTeamDelete.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-invite", () => ({
  cmdTeamInvite: async (...args: unknown[]) => calls.cmdTeamInvite.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/oracle-members", () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.cmdOracleMembers.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-helpers", () => ({
  loadTeam: (...args: unknown[]) => {
    calls.loadTeam?.push(args);
    return loadTeamResult;
  },
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

beforeEach(() => {
  resetCalls();
  resetEnv();
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-vendor-team-index-"));
  preflightErrors = [];
  loadTeamResult = undefined;
});

describe("vendor team index handler isolated coverage", () => {
  test("uses writer when listing teams from non-cli invocation", async () => {
    const written: string[] = [];
    const result = await teamHandler({ source: "api", args: ["ignored"], writer: (...parts: unknown[]) => written.push(parts.join(" ")) });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamList).toHaveLength(1);
    expect(written).toEqual(["listed teams"]);
  });

  test("forwards create description to team creation", async () => {
    const result = await teamHandler({ source: "cli", args: ["new", "blue", "--description", "blue team"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamCreate).toEqual([["blue", { description: "blue team" }]]);
  });

  test("returns failed preflight output when charter has errors", async () => {
    preflightErrors = ["missing role"];
    const result = await teamHandler({ source: "cli", args: ["check", "team.yaml"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("preflight failed");
    expect(result.output).toBe("preflight:1");
  });

  test("loads charter when no-spawn safety flag is present", async () => {
    const result = await teamHandler({ source: "cli", args: ["load", "team.yaml", "--no-spawn"] });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("load:team.yaml");
  });

  test("strips known flags out of greedy spawn prompt", async () => {
    const result = await teamHandler({ source: "cli", args: ["spawn", "alpha", "engineer", "--model", "gpt-x", "--cwd", "/tmp/work", "--prompt", "hello", "agent", "--exec", "--model", "ignored"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamSpawn).toEqual([["alpha", "engineer", {
      model: "gpt-x",
      prompt: "hello agent",
      exec: true,
      cwd: "/tmp/work",
    }]]);
  });

  test("adds task against the only configured team when no team flag is provided", async () => {
    writeTeamConfig("solo-team");
    const result = await teamHandler({ source: "cli", args: ["add", "write", "tests", "--assign", "qa", "--description", "cover branch"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskAdd).toEqual([["solo-team", "write tests", { assign: "qa", description: "cover branch" }]]);
  });

  test("marks task done using explicit team flag", async () => {
    const result = await teamHandler({ source: "cli", args: ["done", "42", "--team", "explicit-team"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskDone).toEqual([["explicit-team", 42]]);
  });

  test("sends enter only to non-lead members with panes", async () => {
    process.env.MAW_TEAM = "active-team";
    loadTeamResult = {
      name: "active-team",
      members: [
        { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "alice", agentId: "alice@active-team", tmuxPaneId: "%1" },
        { name: "bob", agentId: "bob@active-team" },
        { name: "cara", agentId: "cara@active-team", tmuxPaneId: "%3" },
      ],
    };

    const result = await teamHandler({ source: "cli", args: ["enter", "all"] });
    expect(result.ok).toBe(true);
    expect(calls.hostExec).toEqual([
      "tmux send-keys -t '%1' Enter",
      "tmux send-keys -t '%3' Enter",
    ]);
  });

  test("reports unknown subcommand with usage output", async () => {
    const result = await teamHandler({ source: "cli", args: ["mystery"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown subcommand: mystery");
    expect(result.output).toContain("usage: maw team");
  });
});
