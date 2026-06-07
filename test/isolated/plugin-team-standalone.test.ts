import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

let calls: Array<{ name: string; args: unknown[] }> = [];
let targets: string[] = [];
let hostExecCalls: string[] = [];

function record(name: string, value?: unknown) {
  calls.push({ name, args: value === undefined ? [] : [value] });
}

function parseFlags(args: string[], spec: Record<string, unknown>, start = 0) {
  const out: Record<string, any> & { _: string[] } = { _: [] };
  for (let i = start; i < args.length; i += 1) {
    const arg = args[i]!;
    const parser = spec[arg];
    if (!parser) {
      out._.push(arg);
    } else if (typeof parser === "string") {
      out[parser] = true;
    } else if (parser === Boolean) {
      out[arg] = true;
    } else if (parser === String || parser === Number) {
      out[arg] = args[++i];
    }
  }
  return out;
}

const sdkMock = {
  parseFlags,
  hostExec: async (cmd: string) => { hostExecCalls.push(cmd); return ""; },
};

mock.module("maw-js/sdk", () => sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => sdkMock);
mock.module(import.meta.resolve("../../src/commands/shared/wake-session.ts"), () => ({
  writeWorktreeEngineFile: (...args: unknown[]) => record("writeWorktreeEngineFile", args),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/impl.ts"), () => ({
  cmdTeamCreate: (team: string, opts: unknown) => record("create", { team, opts }),
  cmdTeamSpawn: async (...args: unknown[]) => calls.push({ name: "spawn", args }),
  cmdTeamShutdown: async (...args: unknown[]) => calls.push({ name: "shutdown", args }),
  cmdTeamList: async () => record("list"),
  cmdTeamSend: (...args: unknown[]) => calls.push({ name: "send", args }),
  cmdTeamBroadcast: async (...args: unknown[]) => calls.push({ name: "broadcast", args }),
  cmdTeamBring: async (...args: unknown[]) => calls.push({ name: "bring", args }),
  cmdTeamResume: (...args: unknown[]) => calls.push({ name: "resume", args }),
  cmdTeamLives: (...args: unknown[]) => calls.push({ name: "lives", args }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-comms.ts"), () => ({
  teamMessageTargets: () => targets,
  resolveTeamSendMode: (args: string[], knownTargets: string[]) => {
    if (knownTargets.includes(args[0]!)) return { mode: "single", agent: args[0], message: args.slice(1).join(" ") };
    return { mode: "broadcast", message: args.join(" ") };
  },
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/task-ops.ts"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.push({ name: "task-add", args }),
  cmdTeamTaskList: (...args: unknown[]) => calls.push({ name: "task-list", args }),
  cmdTeamTaskDone: (...args: unknown[]) => calls.push({ name: "task-done", args }),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.push({ name: "task-assign", args }),
}));

const { command, default: teamHandler } = await import("../../src/vendor/mpr-plugins/team/index.ts?plugin-team-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  calls = [];
  targets = [];
  hostExecCalls = [];
  delete process.env.MAW_TEAM;
});

describe("team command plugin standalone boundary (#2336)", () => {
  test("entrypoint uses SDK rather than direct plugin/cli/core imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/team/index.ts"), "utf8");
    const specs = [...source.matchAll(/\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]);
    const forbidden = specs.filter((spec) =>
      spec?.startsWith("maw-js/plugin")
      || spec?.startsWith("maw-js/cli/")
      || spec?.startsWith("maw-js/core/")
      || spec?.startsWith("maw-js/commands/shared/")
      || spec === "maw-js/config",
    );

    expect(command).toMatchObject({ name: "team" });
    expect(forbidden).toEqual([]);
    expect(specs).toContain("maw-js/sdk");
    const sdk = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    expect(sdk).toContain("parseFlags");
    expect(sdk).toContain("hostExec");
  });

  test("create, list, bring, and send paths dispatch through mocked seams", async () => {
    await expect(teamHandler({ source: "cli", args: ["create", "avengers", "--description", "ship", "fast"] } as any))
      .resolves.toMatchObject({ ok: true });
    expect(calls.pop()).toEqual({ name: "create", args: [{ team: "avengers", opts: { description: "ship fast" } }] });

    await teamHandler({ source: "cli", args: ["list"] } as any);
    expect(calls.pop()).toEqual({ name: "list", args: [] });

    await teamHandler({ source: "cli", args: ["bring", "avengers", "--session", "alpha", "--dry-run", "--split"] } as any);
    expect(calls.pop()).toEqual({ name: "bring", args: ["avengers", { session: "alpha", engine: undefined, dryRun: true, split: true, gather: false }] });

    targets = ["neo"];
    await teamHandler({ source: "cli", args: ["send", "avengers", "neo", "hello", "there"] } as any);
    expect(calls.pop()).toEqual({ name: "send", args: ["avengers", "neo", "hello there"] });

    targets = ["neo"];
    await teamHandler({ source: "cli", args: ["send", "avengers", "hello", "all"] } as any);
    expect(calls.pop()).toEqual({ name: "broadcast", args: ["avengers", "hello all"] });
  });

  test("validation paths return InvokeResult errors without side effects", async () => {
    const create = await teamHandler({ source: "cli", args: ["create"] } as any);
    expect(create).toMatchObject({ ok: false, error: "name required" });
    expect(stripAnsi(create.output)).toContain("usage: maw team create <name>");

    const spawn = await teamHandler({ source: "cli", args: ["spawn", "avengers"] } as any);
    expect(spawn).toMatchObject({ ok: false, error: "team and role required" });

    const unknown = await teamHandler({ source: "cli", args: ["nope"] } as any);
    expect(unknown).toMatchObject({ ok: false, error: "unknown subcommand: nope" });
    expect(calls).toEqual([]);
  });

  test("enter subcommand sends tmux enter via SDK hostExec", async () => {
    mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-helpers.ts"), () => ({
      loadTeam: () => ({ members: [{ name: "builder", agentId: "builder@avengers", agentType: "worker", tmuxPaneId: "%42" }] }),
    }));
    process.env.MAW_TEAM = "avengers";

    const result = await teamHandler({ source: "cli", args: ["enter", "builder"] } as any);

    expect(result.ok).toBe(true);
    expect(hostExecCalls).toEqual(["tmux send-keys -t '%42' Enter"]);
    expect(stripAnsi(result.output)).toContain("enter sent to builder@avengers");
  });
});
