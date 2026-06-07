import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

let home = "/Users/tester";
let host = "white";
let configExistsValue = false;
let backupPath = "/tmp/maw.config.json.bak";
let parseResult: any = { ok: true, opts: { node: "white", federate: false, peers: [], force: false, backup: false } };
let buildConfigCalls: any[] = [];
let buildConfigResult: any = { built: true };
let writeCalls: any[] = [];
let backupCalls: string[] = [];
let generatedToken = "federation-token-123";
let bootstrapResult: any = { created: false, path: "/tmp/plugins.lock" };
let bootstrapError: Error | null = null;
let runPromptLoopResult: any = { node: "white", token: "", federate: false, peers: [] };
let runPromptLoopError: Error | null = null;
let fleetDirExists = false;
let fleetEntries: string[] = [];
let ttyAnswers: string[] = [];
let askCalls: Array<{ question: string; defaultVal?: string }> = [];
let stderrWrites: string[] = [];

mock.module("os", () => ({
  homedir: () => home,
  hostname: () => host,
}));

mock.module("fs", () => ({
  existsSync: (path: string) => (path === "/tmp/fleet" ? fleetDirExists : false),
  readdirSync: (_path: string) => fleetEntries,
}));

mock.module("maw-js/core/paths", () => ({
  CONFIG_FILE: "/tmp/maw.config.json",
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => "/tmp/fleet",
  loadFleetEntries: () => fleetEntries
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, path: `/tmp/fleet/${file}`, num: 0, groupName: file, session: { name: file, windows: [] } })),
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/non-interactive"), () => ({
  parseNonInteractive: (..._args: any[]) => parseResult,
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/write-config"), () => ({
  buildConfig: (input: any) => {
    buildConfigCalls.push(input);
    return buildConfigResult;
  },
  configExists: (_path: string) => configExistsValue,
  backupConfig: (path: string) => {
    backupCalls.push(path);
    return backupPath;
  },
  writeConfigAtomic: (path: string, config: any, overwrite: boolean) => {
    writeCalls.push({ path, config, overwrite });
  },
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/federation"), () => ({
  generateFederationToken: () => generatedToken,
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/bootstrap-plugins-lock"), () => ({
  bootstrapPluginsLock: () => {
    if (bootstrapError) throw bootstrapError;
    return bootstrapResult;
  },
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/prompts"), () => ({
  ttyAsk: async (question: string, defaultVal = "") => {
    askCalls.push({ question, defaultVal });
    return ttyAnswers.shift() ?? defaultVal;
  },
  runPromptLoop: async (..._args: any[]) => {
    if (runPromptLoopError) throw runPromptLoopError;
    return runPromptLoopResult;
  },
}));

const origLog = console.log;
const origErrWrite = process.stderr.write.bind(process.stderr);
const origEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { chooseExistingAction, cmdInit } = await import("../../src/vendor/mpr-plugins/init/impl");

beforeEach(() => {
  home = "/Users/tester";
  host = "white";
  configExistsValue = false;
  backupPath = "/tmp/maw.config.json.bak";
  parseResult = { ok: true, opts: { node: "white", federate: false, peers: [], force: false, backup: false } };
  buildConfigCalls = [];
  buildConfigResult = { built: true };
  writeCalls = [];
  backupCalls = [];
  generatedToken = "federation-token-123";
  bootstrapResult = { created: false, path: "/tmp/plugins.lock" };
  bootstrapError = null;
  runPromptLoopResult = { node: "white", token: "", federate: false, peers: [] };
  runPromptLoopError = null;
  fleetDirExists = false;
  fleetEntries = [];
  ttyAnswers = [];
  askCalls = [];
  stderrWrites = [];
  console.log = () => {};
  process.stderr.write = ((chunk: any) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as any;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterAll(() => {
  console.log = origLog;
  process.stderr.write = origErrWrite as any;
  if (origEnvToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = origEnvToken;
});

describe("init impl coverage", () => {
  test("chooseExistingAction honors overwrite/backup and falls back to the provided default", async () => {
    const ask = async () => "overwrite";
    await expect(chooseExistingAction(ask, "abort")).resolves.toBe("overwrite");
    await expect(chooseExistingAction(async () => "b", "abort")).resolves.toBe("backup");
    await expect(chooseExistingAction(async () => "???", "backup")).resolves.toBe("backup");
  });

  test("non-interactive parse errors and existing-config refusal return structured failures", async () => {
    parseResult = { ok: false, error: "bad flags" };
    await expect(cmdInit({ args: ["--non-interactive"] })).resolves.toEqual({ ok: false, error: "bad flags" });

    parseResult = { ok: true, opts: { node: "white", federate: false, peers: [], force: false, backup: false } };
    configExistsValue = true;
    const refused = await cmdInit({ args: ["--non-interactive"] });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("Use --force to overwrite or --backup");
  });

  test("non-interactive backup mode warns for missing token, bootstraps lock, and prints federation token", async () => {
    configExistsValue = true;
    parseResult = {
      ok: true,
      opts: {
        node: "white",
        ghqRoot: "/ghq",
        token: undefined,
        federate: true,
        peers: [{ name: "mba", url: "http://mba:3456" }],
        federationToken: undefined,
        force: false,
        backup: true,
      },
    };
    buildConfigResult = { node: "white", namedPeers: [{ name: "mba", url: "http://mba:3456" }] };
    bootstrapError = new Error("disk full");
    const out: string[] = [];

    const result = await cmdInit({ args: ["--non-interactive"], writer: (msg) => out.push(msg) });

    expect(result).toMatchObject({ ok: true, configPath: "/tmp/maw.config.json", config: buildConfigResult });
    expect(backupCalls).toEqual(["/tmp/maw.config.json"]);
    expect(buildConfigCalls[0]).toMatchObject({ node: "white", ghqRoot: "/ghq", federate: true, federationToken: "federation-token-123" });
    expect(writeCalls).toEqual([{ path: "/tmp/maw.config.json", config: buildConfigResult, overwrite: true }]);
    expect(stderrWrites.join("\n")).toContain("no --token and no CLAUDE_CODE_OAUTH_TOKEN env");
    expect(out.join("\n")).toContain("backed up to /tmp/maw.config.json.bak");
    expect(out.join("\n")).toContain("Wrote /tmp/maw.config.json");
    expect(out.join("\n")).toContain("plugins.lock bootstrap skipped — disk full");
    expect(out.join("\n")).toContain("federation token");
    expect(out.join("\n")).toContain("share with each peer");
  });

  test("interactive mode can abort cleanly before touching config", async () => {
    configExistsValue = true;
    const out: string[] = [];
    const result = await cmdInit({ args: [], ask: async () => "", writer: (msg) => out.push(msg) });

    expect(result).toEqual({ ok: true });
    expect(writeCalls).toEqual([]);
    expect(out.join("\n")).toContain("Found existing config");
    expect(out.join("\n")).toContain("Aborted. Existing config untouched.");
  });

  test("interactive prompt-loop failures surface as structured errors, and success prints fleet/token/next steps", async () => {
    runPromptLoopError = new Error("prompt failed");
    let result = await cmdInit({ args: [], ask: async () => "ignored", writer: () => {} });
    expect(result).toEqual({ ok: false, error: "prompt failed" });

    runPromptLoopError = null;
    configExistsValue = true;
    runPromptLoopResult = {
      node: "white",
      token: "oauth-token",
      federate: true,
      peers: [{ name: "mba", url: "http://mba:3456" }],
    };
    buildConfigResult = { node: "white", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" } };
    bootstrapResult = { created: true, path: "/tmp/plugins.lock" };
    fleetDirExists = true;
    fleetEntries = ["01-alpha.json", "notes.txt", "02-beta.json"];
    const out: string[] = [];

    result = await cmdInit({ args: [], ask: async () => "backup", writer: (msg) => out.push(msg) });

    expect(result).toMatchObject({ ok: true, configPath: "/tmp/maw.config.json", config: buildConfigResult });
    expect(backupCalls).toEqual(["/tmp/maw.config.json"]);
    expect(buildConfigCalls.at(-1)).toMatchObject({ node: "white", token: "oauth-token", federate: true, federationToken: "federation-token-123" });
    expect(out.join("\n")).toContain("plugins.lock (bootstrap)");
    expect(out.join("\n")).toContain("Fleet dir ready: /tmp/fleet");
    expect(out.join("\n")).toContain("(2 entries)");
    expect(out.join("\n")).toContain("Generated federation token");
    expect(out.join("\n")).toContain("maw serve");
    expect(out.join("\n")).toContain("maw wake <repo>");
    expect(out.join("\n")).toContain("maw bud <name>");
  });
});
