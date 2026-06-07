import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type CallRecord = Record<string, unknown[][]>;

const calls: CallRecord = {
  cmdTeamList: [],
  cmdTeamResume: [],
  cmdTeamLives: [],
  cmdTeamShutdown: [],
  cmdTeamTaskList: [],
  cmdTeamStatus: [],
  cmdTeamDelete: [],
  cmdTeamInvite: [],
};

let homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-third-pass-"));
const originalSpawnSync = Bun.spawnSync;

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async () => "",
}));

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    for (let i = startIndex; i < args.length; i++) {
      const token = args[i] ?? "";
      if (token in schema) {
        const valueType = schema[token];
        if (valueType === Boolean) {
          out[token] = true;
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

mock.module("../../src/vendor/mpr-plugins/team/impl", () => ({
  cmdTeamCreate: () => {},
  cmdTeamSpawn: async () => {},
  cmdTeamSend: () => {},
  cmdTeamBroadcast: async () => {},
  cmdTeamBring: async () => {},
  cmdTeamList: () => {
    calls.cmdTeamList.push([]);
    console.error("listed on stderr");
  },
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
}));

mock.module("../../src/vendor/mpr-plugins/team/team-comms", () => ({
  resolveTeamSendMode: () => ({ mode: "broadcast", message: "unused" }),
  teamMessageTargets: () => [],
}));

mock.module("../../src/vendor/mpr-plugins/team/task-ops", () => ({
  cmdTeamTaskAdd: () => {},
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: () => {},
  cmdTeamTaskAssign: () => {},
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
  cmdOracleInvite: () => {},
  cmdOracleRemove: () => {},
  cmdOracleMembers: () => {},
}));

const { default: teamHandler } = await import("../../src/vendor/mpr-plugins/team/index");

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
}

function resetEnv() {
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
}

beforeEach(() => {
  resetCalls();
  resetEnv();
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-team-index-third-pass-"));
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
});

describe("vendor team index third-pass coverage", () => {
  test("routes stderr through the invoke writer", async () => {
    const written: string[] = [];

    const result = await teamHandler({
      source: "cli",
      args: ["list"],
      writer: (...parts: unknown[]) => written.push(parts.map(String).join(" ")),
    });

    expect(result.ok).toBe(true);
    expect(calls.cmdTeamList).toEqual([[]]);
    expect(written).toEqual(["listed on stderr"]);
    expect(result.output).toBeUndefined();
  });

  test("reports remaining direct usage guards", async () => {
    const cases: Array<{ args: string[]; error: string; output: string }> = [
      { args: ["load"], error: "charter path required", output: "usage: maw team load" },
      { args: ["spawn-from"], error: "charter path required", output: "usage: maw team spawn-from" },
      { args: ["invite"], error: "team and peer required", output: "usage: maw team invite" },
    ];

    for (const c of cases) {
      const result = await teamHandler({ source: "cli", args: c.args });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(c.error);
      expect(result.output).toContain(c.output);
    }

    expect(calls.cmdTeamInvite).toHaveLength(0);
  });

  test("dispatches resume, lives, shutdown, status, and delete success paths", async () => {
    await teamHandler({ source: "cli", args: ["resume", "team-a", "--model", "gpt-x"] });
    await teamHandler({ source: "cli", args: ["history", "agent-a"] });
    await teamHandler({ source: "cli", args: ["down", "team-a", "--force", "--merge"] });
    await teamHandler({ source: "cli", args: ["status", "team-a"] });
    await teamHandler({ source: "cli", args: ["delete", "team-a"] });

    expect(calls.cmdTeamResume).toEqual([["team-a", { model: "gpt-x" }]]);
    expect(calls.cmdTeamLives).toEqual([["agent-a"]]);
    expect(calls.cmdTeamShutdown).toEqual([["team-a", { force: true, merge: true }]]);
    expect(calls.cmdTeamStatus).toEqual([["team-a"]]);
    expect(calls.cmdTeamDelete).toEqual([["team-a"]]);
  });

  test("tasks falls back to default when tmux context probing fails", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,1,0";
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => {
      throw new Error("tmux failed");
    }) as typeof Bun.spawnSync;

    const result = await teamHandler({ source: "cli", args: ["tasks"] });

    expect(result.ok).toBe(true);
    expect(calls.cmdTeamTaskList).toEqual([["default"]]);
  });
});
