import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => {
  mock.restore();
  if (origMawTeam === undefined) delete process.env.MAW_TEAM;
  else process.env.MAW_TEAM = origMawTeam;
  if (origTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = origTmux;
});

import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { isUserError } from "../../src/core/util/user-error";

const root = join(import.meta.dir, "../..");

let calls: Array<{ name: string; args: unknown[] }> = [];
let targets: string[] = [];
let hostExecCalls: string[] = [];
const origMawTeam = process.env.MAW_TEAM;
const origTmux = process.env.TMUX;

function record(name: string, value?: unknown) {
  calls.push({ name, args: value === undefined ? [] : [value] });
}

function parseFlags(args: string[], spec: Record<string, unknown>, start = 0) {
  const out: Record<string, any> & { _: string[] } = { _: [] };
  for (let i = start; i < args.length; i += 1) {
    const arg = args[i]!;
    const rawParser = spec[arg];
    const key = typeof rawParser === "string" ? rawParser : arg;
    const parser = typeof rawParser === "string" ? spec[rawParser] : rawParser;
    if (!parser) {
      out._.push(arg);
    } else if (parser === Boolean) {
      out[key] = true;
    } else if (parser === String || parser === Number) {
      const value = args[++i];
      out[key] = parser === Number ? Number(value) : value;
    }
  }
  return out;
}

const sdkMock = {
  parseFlags,
  hostExec: async (cmd: string) => { hostExecCalls.push(cmd); return ""; },
  tmux: {
    listPaneIds: async () => new Set<string>(),
    killPane: async () => undefined,
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/commands/shared/wake-session.ts"), () => ({
  writeWorktreeEngineFile: (...args: unknown[]) => record("writeWorktreeEngineFile", args),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/impl.ts"), () => ({
  cmdTeamCreate: (team: string, opts: unknown) => record("create", { team, opts }),
  cmdTeamPrune: async (...args: unknown[]) => calls.push({ name: "prune", args }),
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
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-up.ts"), () => ({
  cmdTeamUp: async (...args: unknown[]) => {
    calls.push({ name: "up", args });
    const deps = args[2] as { readTeamCharterFn?: () => unknown } | undefined;
    deps?.readTeamCharterFn?.();
  },
  quickCharter: (...args: unknown[]) => {
    calls.push({ name: "quick-charter", args });
    return { name: "quick", members: [] };
  },
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-apply.ts"), () => ({
  cmdTeamApply: async (...args: unknown[]) => calls.push({ name: "apply", args }),
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
  process.env.MAW_TEAM = "default";
  delete process.env.TMUX;
});

describe("team command plugin standalone boundary (#2336)", () => {
  test("entrypoint and touched team-up files keep explicit standalone import boundaries", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "team",
      files: ["index.ts", "team-liveness.ts", "team-up.ts", "team-apply.ts"],
      allowRelative: [
        "../../../core/transport/tmux",
        "../../../core/agent-detect",
        "../../../config/load",
        "../../../config/types",
        "../../../config/engine-registry",
        "../../../commands/shared/wake-cmd",
        "../../../commands/shared/comm-send",
        "../../../core/util/user-error",
        "../done/impl",
      ],
    }).map((record) => record.spec);


    expect(command).toMatchObject({ name: "team" });
    expect(imports).toContain("maw-js/sdk");
    expect(imports).toEqual(expect.arrayContaining(["./team-up", "./team-apply", "../../../commands/shared/wake-cmd"]));
    const teamUp = readFileSync(join(root, "src/vendor/mpr-plugins/team/team-up.ts"), "utf8");
    expect(teamUp).toContain("Promise.all(launchTasks.map((task) => task.run()))");
    expect(teamUp).toContain("Promise.all(launchTasks.map((task) => waitForNonShell");
    expect(teamUp).toContain("validateRosterEngines(roster, charter, config, opts.engine)");
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

    await teamHandler({ source: "cli", args: ["up", "avengers", "--members", "coder-1, oracle", "--session", "alpha", "--dry-run"] } as any);
    expect(calls.pop()).toEqual({
      name: "up",
      args: ["avengers", {
        dryRun: true,
        status: false,
        force: false,
        gather: false,
        engine: undefined,
        only: [],
        members: ["coder-1", "oracle"],
        session: "alpha",
      }],
    });

    await teamHandler({ source: "cli", args: ["apply", "avengers", "--session", "alpha", "--charter", "/tmp/team.yaml", "--apply"] } as any);
    expect(calls.pop()).toEqual({
      name: "apply",
      args: ["avengers", { apply: true, session: "alpha", charterPath: "/tmp/team.yaml" }],
    });
  });


  test("team engine resolver fails loud on unresolved member engine", async () => {
    const actualLiveness = await import("../../src/vendor/mpr-plugins/team/team-liveness.ts?plugin-team-preflight-2707");
    let thrown: unknown;

    try {
      actualLiveness.assertTeamEngineResolvable("omx", {}, { commands: { default: "claude", codex: "codex" } } as any);
    } catch (error) {
      thrown = error;
    }

    expect(isUserError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("engine 'omx' not resolvable");
    expect((thrown as Error).message).toContain("known:");
  });


  test("team up --quick dispatches through an in-memory charter seam", async () => {
    await expect(teamHandler({ source: "cli", args: ["up", "--quick", "3", "-e", "omx", "--session", "charter-session"] } as any))
      .resolves.toMatchObject({ ok: true });

    expect(calls.find((call) => call.name === "quick-charter")).toMatchObject({
      args: [3, { name: "quick", engine: "omx", session: "charter-session" }],
    });
    expect(calls.find((call) => call.name === "up")).toMatchObject({
      args: ["quick", expect.objectContaining({ quick: 3, engine: "omx", session: "charter-session" }), expect.objectContaining({ charterPath: null })],
    });
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


  test("team spawn honors config.defaultEngine fallback without explicit --engine", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "maw-team-standalone-"));
    const cwd = join(tmp, "repo");
    const psi = join(cwd, "ψ");
    const teamsDir = join(tmp, "teams");
    const tasksDir = join(tmp, "tasks");
    mkdirSync(join(psi, "memory", "mailbox", "teams", "avengers"), { recursive: true });
    mkdirSync(join(teamsDir, "avengers"), { recursive: true });
    writeFileSync(join(cwd, "CLAUDE.md"), "oracle repo\n");
    writeFileSync(join(psi, "memory", "mailbox", "teams", "avengers", "manifest.json"), JSON.stringify({ name: "avengers", members: [] }));
    writeFileSync(join(teamsDir, "avengers", "config.json"), JSON.stringify({ name: "avengers", members: [] }));

    const testConfig = {
      defaultEngine: "codex",
      commands: {},
      engines: {
        codex: {
          cmd: "codex",
          model: { flag: "--model", default: "gpt-5.5" },
          capabilities: ["model", "system-prompt-file"],
        },
      },
    };
    mock.module(import.meta.resolve("../../src/config/load.ts"), () => ({
      loadConfig: () => testConfig,
      loadConfigWithProvenance: () => ({ config: testConfig, sources: [], provenance: {}, warnings: [] }),
      resetConfig: () => undefined,
      saveConfig: () => undefined,
      configForDisplay: () => testConfig,
      cfgInterval: () => 1,
      cfgTimeout: () => 1,
      cfgLimit: () => 80,
      cfg: (key: keyof typeof testConfig) => testConfig[key],
    }));

    const helpers = await import("../../src/vendor/mpr-plugins/team/team-helpers.ts");
    helpers._setDirs(teamsDir, tasksDir);
    const lifecycle = await import("../../src/vendor/mpr-plugins/team/team-lifecycle.ts?plugin-team-default-engine");
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      await lifecycle.cmdTeamSpawn("avengers", "builder");

      const toolConfig = JSON.parse(readFileSync(join(teamsDir, "avengers", "config.json"), "utf8"));
      expect(toolConfig.members).toEqual([{ name: "builder", engine: "codex", model: "gpt-5.5" }]);
      const prompt = readFileSync(join(psi, "memory", "mailbox", "teams", "avengers", "builder-spawn-prompt.md"), "utf8");
      expect(prompt).toContain("You are 'builder' on team 'avengers'.");
    } finally {
      process.chdir(previousCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("team charter standalone parser applies defaults block inheritance", async () => {
    const { parseTeamCharterText, formatTeamCharterPlan, planTeamCharter } = await import(
      "../../src/vendor/mpr-plugins/team/team-charter.ts?plugin-team-charter-defaults-standalone"
    );

    const charter = parseTeamCharterText(`
name: standalone-defaults
defaults:
  engine: omx
  worktree: true
  branch: alpha
  unexpected: ignored

members:
  - role: lead
    engine: claude
    worktree: false
  - role: builder
agents:
  verifier:
    branch: beta
`);

    expect(charter.defaults).toEqual({ engine: "omx", worktree: true, branch: "alpha" });
    expect(charter.warnings).toEqual(["defaults has unsupported key: unexpected"]);
    expect(charter.members).toEqual([
      { role: "lead", engine: "claude", worktree: false, branch: "alpha" },
      { role: "builder", engine: "omx", worktree: true, branch: "alpha" },
      { role: "verifier", engine: "omx", worktree: true, branch: "beta" },
    ]);
    expect(formatTeamCharterPlan(planTeamCharter(charter))).toContain(
      "verifier (target=auto, engine=omx, worktree=true, branch=beta)",
    );
  });

  test("memberEngine honors config.defaultEngine without hard-coded claude fallback", async () => {
    mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd.ts"), () => ({
      cmdWake: async () => "",
    }));
    const { memberEngine, resolveCharterEngineCommand } = await import("../../src/vendor/mpr-plugins/team/team-liveness.ts?plugin-team-member-engine");

    expect(memberEngine({ role: "builder" } as any, undefined, { defaultEngine: "codex" } as any)).toBe("codex");
    expect(memberEngine({ role: "builder", model: "opencode" } as any, undefined, { defaultEngine: "codex" } as any)).toBe("opencode");
    expect(memberEngine({ role: "builder", engine: "aider" } as any, undefined, { defaultEngine: "codex" } as any)).toBe("aider");
    expect(memberEngine({ role: "builder", engine: "aider" } as any, "thclaws", { defaultEngine: "codex" } as any)).toBe("thclaws");
    expect(memberEngine({ role: "builder" } as any, undefined, { commands: { default: "codex --legacy" } } as any)).toBe("default");
    expect(() => memberEngine({ role: "builder" } as any, undefined, {} as any)).toThrow(/no default engine configured/);
    expect(resolveCharterEngineCommand("opus48", { opus48: ["claude --model opus", ["--dangerously-skip-permissions"]] })).toBe("claude --model opus --dangerously-skip-permissions");
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
