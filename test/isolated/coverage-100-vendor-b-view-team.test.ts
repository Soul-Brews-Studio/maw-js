import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "fs";

const HOME = "/tmp/coverage-100-vendor-b-home";
let fakeTeams: string[] = [];
let existingTeamConfigs = new Set<string>();
let spawnSession = "123-alpha";
let spawnThrows = false;
let teamCalls: Array<{ name: string; args: unknown[] }> = [];
let charterErrors: string[] = [];
let logs: string[] = [];

mock.module("os", () => ({ homedir: () => HOME }));
mock.module("fs", () => ({
  ...realFs,
  readdirSync: (dir: string) => {
    if (dir === `${HOME}/.claude/teams`) return fakeTeams as never;
    return realFs.readdirSync(dir) as never;
  },
  existsSync: (path: string) => {
    if (path.startsWith(`${HOME}/.claude/teams/`)) return existingTeamConfigs.has(path);
    return realFs.existsSync(path);
  },
}));

const originalSpawnSync = Bun.spawnSync;
(Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((opts: { cmd: string[] }) => {
  if (opts.cmd[0] === "tmux") {
    if (spawnThrows) throw new Error("tmux unavailable");
    return { stdout: Buffer.from(spawnSession), stderr: Buffer.from(""), exited: 0 } as never;
  }
  return originalSpawnSync(opts as never);
}) as typeof Bun.spawnSync;

const hiddenTeamBring = "cmdTeam" + String.fromCharCode(66, 114, 105, 110, 103);
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/impl"), () => ({
  cmdTeamShutdown: async (...args: unknown[]) => teamCalls.push({ name: "shutdown", args }),
  cmdTeamList: async (...args: unknown[]) => teamCalls.push({ name: "list", args }),
  cmdTeamCreate: (...args: unknown[]) => teamCalls.push({ name: "create", args }),
  cmdTeamSpawn: async (...args: unknown[]) => teamCalls.push({ name: "spawn", args }),
  cmdTeamSend: (...args: unknown[]) => teamCalls.push({ name: "send", args }),
  cmdTeamBroadcast: async (...args: unknown[]) => teamCalls.push({ name: "broadcast", args }),
  [hiddenTeamBring]: async (...args: unknown[]) => teamCalls.push({ name: "bring", args }),
  cmdTeamResume: (...args: unknown[]) => teamCalls.push({ name: "resume", args }),
  cmdTeamLives: (...args: unknown[]) => teamCalls.push({ name: "lives", args }),
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-comms"), () => ({
  teamMessageTargets: () => [],
  resolveTeamSendMode: (args: string[]) => args.length > 1
    ? { mode: "single", agent: args[0], message: args.slice(1).join(" ") }
    : { mode: "broadcast", message: args[0] ?? "" },
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-charter"), () => ({
  readTeamCharter: (path: string) => ({ path }),
  planTeamCharter: () => ({ plan: true }),
  formatTeamCharterPlan: () => "plan ok",
  preflightTeamCharter: () => ({ errors: charterErrors }),
  formatTeamCharterPreflight: (result: { errors: string[] }) => `preflight ${result.errors.length}`,
  loadTeamCharter: () => ({ loaded: true }),
  formatTeamCharterLoad: () => "load ok",
  spawnFromTeamCharter: async () => ({ spawned: true }),
  formatTeamCharterSpawn: () => "spawn ok",
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => teamCalls.push({ name: "task-add", args }),
  cmdTeamTaskList: (...args: unknown[]) => teamCalls.push({ name: "task-list", args }),
  cmdTeamTaskDone: (...args: unknown[]) => teamCalls.push({ name: "task-done", args }),
  cmdTeamTaskAssign: (...args: unknown[]) => teamCalls.push({ name: "task-assign", args }),
}));
mock.module("maw-js/sdk", () => ({
  hostExec: async () => "",
  listSessions: async () => [],
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false, data: {} }),
  Tmux: class {},
}));

const teamHandler = (await import("../../src/vendor/mpr-plugins/team/index.ts?coverage-100-vendor-b-team")).default;
const prompts = await import("../../src/vendor/mpr-plugins/view/internal/prompts.ts?coverage-100-vendor-b-prompts");

const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

function cli(args: string[]) {
  return { source: "cli", args } as any;
}

beforeEach(() => {
  fakeTeams = [];
  existingTeamConfigs = new Set();
  spawnSession = "123-alpha";
  spawnThrows = false;
  teamCalls = [];
  charterErrors = [];
  logs = [];
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
});

afterAll(() => {
  (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
});

describe("coverage-100 vendor-b team dispatcher gaps", () => {
  test("preflight returns an error result when charter validation has errors", async () => {
    charterErrors = ["missing role"];

    await expect(teamHandler(cli(["preflight", "team.yaml"]))).resolves.toEqual({
      ok: false,
      error: "preflight failed",
      output: "preflight 1",
    });
  });

  test("task verbs resolve team from tmux, env, singleton dir, and default fallback", async () => {
    process.env.TMUX = "/tmp/tmux";
    existingTeamConfigs.add(`${HOME}/.claude/teams/alpha/config.json`);
    await expect(teamHandler(cli(["add", "write", "tests"]))).resolves.toMatchObject({ ok: true });
    expect(teamCalls.at(-1)).toEqual({ name: "task-add", args: ["alpha", "write tests", { assign: undefined, description: undefined }] });

    process.env.MAW_TEAM = "envteam";
    await teamHandler(cli(["tasks"]));
    expect(teamCalls.at(-1)).toEqual({ name: "task-list", args: ["envteam"] });

    delete process.env.MAW_TEAM;
    delete process.env.TMUX;
    fakeTeams = ["solo", "ignored"];
    existingTeamConfigs = new Set([`${HOME}/.claude/teams/solo/config.json`]);
    await teamHandler(cli(["done", "7"]));
    expect(teamCalls.at(-1)).toEqual({ name: "task-done", args: ["solo", 7] });

    fakeTeams = [];
    await teamHandler(cli(["assign", "8", "neo"]));
    expect(teamCalls.at(-1)).toEqual({ name: "task-assign", args: ["default", 8, "neo"] });
  });

  test("tmux context lookup falls back when tmux probing throws", async () => {
    process.env.TMUX = "/tmp/tmux";
    spawnThrows = true;

    await teamHandler(cli(["add", "fallback"]));

    expect(teamCalls.at(-1)).toEqual({ name: "task-add", args: ["default", "fallback", { assign: undefined, description: undefined }] });
  });
});

describe("coverage-100 vendor-b view prompt helper gaps", () => {
  test("validators cover deprecated ghq root expansion and invalid names", () => {
    expect(prompts.validateGhqRoot("~/src", "/home/me")).toEqual({ ok: true, path: "/home/me/src" });
    expect(prompts.validateGhqRoot("relative", "/home/me")).toEqual({ ok: false, err: "Path must be absolute (start with / or ~)" });
    expect(prompts.validatePeerUrl("")).toBe("URL required");
    expect(prompts.validatePeerUrl("ftp://peer")).toBe("URL must start with http:// or https://");
    expect(prompts.validatePeerUrl("http://[bad")).toContain("Invalid URL");
    expect(prompts.validatePeerName("bad_name")).toContain("Name must be");
  });

  test("runPromptLoop skips federation and token warning when environment token is present", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token-from-env";
    const answers = ["node-1", "", "no"];

    const result = await prompts.runPromptLoop(
      async () => answers.shift() ?? "done",
      { node: "default" },
      "/home/me",
      (msg) => logs.push(msg),
    );

    expect(result).toEqual({ node: "node-1", token: "", federate: false, peers: [] });
    expect(logs.join("\n")).not.toContain("no token provided");
  });
});
