import { beforeEach, describe, expect, mock, test } from "bun:test";

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
  readUnread: [],
  readInbox: [],
  markRead: [],
  loadTeam: [],
};

function resetCalls() {
  for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = [];
}

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => calls.cmdTeamSpawn.push(args),
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
  cmdTeamShutdown: (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
  cmdTeamList: () => calls.cmdTeamList.push([]),
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
  loadTeam: (...args: unknown[]) => {
    calls.loadTeam.push(args);
    return undefined;
  },
}));

mock.module(at("../../src/commands/plugins/split/impl"), () => ({
  cmdSplit: (...args: unknown[]) => calls.cmdSplit.push(args),
}));

mock.module(at("../../src/commands/plugins/team/inbox"), () => ({
  readUnread: (...args: unknown[]) => {
    calls.readUnread.push(args);
    return [];
  },
  readInbox: (...args: unknown[]) => {
    calls.readInbox.push(args);
    return [];
  },
  markRead: (...args: unknown[]) => {
    calls.markRead.push(args);
    return 0;
  },
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
        if (v === Boolean) {
          out[token] = true;
        } else if (v === Number) {
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
  hostExec: async () => "",
  withPaneLock: async (fn: () => Promise<void>) => fn(),
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  colorAnsi: () => "31",
  getWindowTarget: async () => "win",
  applyTeamLayout: async () => {},
  applyTiledLayout: async () => {},
  stylePaneBorder: async () => {},
  enableBorderStatus: async () => {},
}));

const { default: teamHandler } = await import("../../src/commands/plugins/team/index");

beforeEach(() => {
  resetCalls();
  process.env.MAW_TEAM = "env-team";
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
});

describe("team command handler coverage slice", () => {
  test("create requires team name", async () => {
    const result = await teamHandler({ source: "cli", args: ["create"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("name required");
  });

  test("spawn requires team and role", async () => {
    const result = await teamHandler({ source: "cli", args: ["spawn", "alpha"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team and role required");
  });

  test("send requires team, agent, and message", async () => {
    const result = await teamHandler({ source: "cli", args: ["send", "alpha"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team, agent, and message required");
  });

  test("done validates task-id", async () => {
    const result = await teamHandler({ source: "cli", args: ["done", "abc"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("usage: maw team done <task-id> [--team <name>]");
  });

  test("assign validates id and agent", async () => {
    const result = await teamHandler({ source: "cli", args: ["assign", "99"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("usage: maw team assign <task-id> <agent> [--team <name>]");
  });

  test("split validates required target", async () => {
    const result = await teamHandler({ source: "cli", args: ["split"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("target required");
  });

  test("close requires tmux", async () => {
    const result = await teamHandler({ source: "cli", args: ["close"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not in tmux");
  });

  test("broadcast requires message", async () => {
    const result = await teamHandler({ source: "cli", args: ["broadcast"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("message required");
  });

  test("broadcast errors when team not found", async () => {
    const result = await teamHandler({ source: "cli", args: ["broadcast", "hello"] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team not found");
  });

  test("tasks uses MAW_TEAM fallback", async () => {
    const result = await teamHandler({ source: "cli", args: ["tasks"] });
    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskList).toEqual([["env-team"]]);
  });

  test("members uses explicit --team first, then fallback", async () => {
    await teamHandler({ source: "cli", args: ["members", "--team", "explicit"] });
    expect(calls.cmdOracleMembers).toEqual([["explicit"]]);

    resetCalls();
    await teamHandler({ source: "cli", args: ["members"] });
    expect(calls.cmdOracleMembers).toEqual([["env-team"]]);
  });
});
