import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const tempDirs: string[] = [];

let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => string | Promise<string> = () => "";
let rustCalls: Array<{ name: string; dest: string }> = [];
let asCalls: Array<{ name: string; dest: string }> = [];

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return await hostExecImpl(cmd);
  },
}));
mock.module(import.meta.resolve("../../src/commands/shared/plugin-create-rust"), () => ({
  scaffoldRust: (name: string, dest: string) => { rustCalls.push({ name, dest }); },
}));
mock.module(import.meta.resolve("../../src/commands/shared/plugin-create-as"), () => ({
  scaffoldAs: (name: string, dest: string) => { asCalls.push({ name, dest }); },
}));

function tmp(prefix: string): string {
  const dir = `${tmpdir()}/${prefix}${crypto.randomUUID()}`;
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function capture(fn: () => unknown | Promise<unknown>): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${exitCode}`);
  };
  try {
    await fn();
  } catch (error: any) {
    if (!String(error?.message ?? "").startsWith("exit:")) throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    (process as any).exit = originalExit;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

beforeEach(() => {
  resetEnv();
  hostExecCalls = [];
  hostExecImpl = () => "";
  rustCalls = [];
  asCalls = [];
});

afterEach(() => {
  resetEnv();
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  (process as any).exit = originalExit;
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("shared scaffold and CLI helper low-hanging branches", () => {
  test("defaultRustSdkPath returns the portable bun-global SDK path when present", async () => {
    delete process.env.MAW_SDK_RUST_PATH;
    const sdkPath = join(homedir(), ".bun", "install", "global", "node_modules", "maw", "src", "wasm", "maw-plugin-sdk");
    const createdForTest = !existsSync(sdkPath);
    if (createdForTest) tempDirs.push(sdkPath);
    mkdirSync(sdkPath, { recursive: true });

    const { defaultRustSdkPath } = await import("../../src/commands/shared/plugin-create-scaffold.ts?coverage-100b-sdk");

    expect(defaultRustSdkPath()).toBe(sdkPath);
  });

  test("cmdPluginCreate resolves --here and default destinations without explicit --dest", async () => {
    const cwd = tmp("maw-plugin-create-cwd-");
    process.chdir(cwd);
    const home = tmp("maw-plugin-create-home-");
    process.env.HOME = home;
    delete process.env.MAW_HOME;
    delete process.env.MAW_DATA_DIR;
    delete process.env.MAW_PLUGIN_HOME;
    delete process.env.MAW_XDG;
    const { cmdPluginCreate } = await import("../../src/commands/shared/plugin-create-cmd.ts?coverage-100b-create-dest");

    let got = await capture(() => cmdPluginCreate("demo-here", { "--rust": true, "--here": true }));
    expect(got.exitCode).toBeUndefined();
    const hereDest = join(realpathSync(cwd), "demo-here");
    expect(rustCalls).toEqual([{ name: "demo-here", dest: hereDest }]);
    expect(got.stdout).toContain(hereDest);

    got = await capture(() => cmdPluginCreate("demo-home", { "--as": true }));
    expect(got.exitCode).toBeUndefined();
    const defaultDest = join(homedir(), ".maw", "plugins", "demo-home");
    expect(asCalls).toEqual([{ name: "demo-home", dest: defaultDest }]);
    expect(got.stdout).toContain(defaultDest);

    const pluginHome = tmp("maw-plugin-create-plugin-home-");
    process.env.MAW_PLUGIN_HOME = pluginHome;
    got = await capture(() => cmdPluginCreate("demo-plugin-home", { "--as": true }));
    expect(got.exitCode).toBeUndefined();
    expect(asCalls.at(-1)).toEqual({ name: "demo-plugin-home", dest: join(pluginHome, "demo-plugin-home") });
  });

  test("checkCapacity includes the action hint in the thrown cap error", async () => {
    const { checkCapacity } = await import("../../src/commands/shared/wake-concurrency.ts?coverage-100b-cap");

    expect(() => checkCapacity(2, 2, "new-agent")).toThrow("or sleep an idle agent first");
    expect(() => checkCapacity(1, Number.NaN, "new-agent")).not.toThrow();
  });
});

describe("wake tmux helper retry and split branches", () => {
  test("waitForTmuxSessionReady throws on requested timeout and retries fresh-session tmux races", async () => {
    const { waitForTmuxSessionReady, retryFreshSessionTmuxStep } = await import("../../src/commands/shared/wake-cmd-helpers.ts?coverage-100b-wake-retry");
    const sleeps: number[] = [];

    await expect(waitForTmuxSessionReady("new-session", {
      attempts: 1,
      delayMs: 7,
      sleep: async (ms: number) => { sleeps.push(ms); },
      throwOnTimeout: true,
    })).rejects.toThrow("tmux did not report fresh session");

    let attempts = 0;
    const result = await retryFreshSessionTmuxStep("new-session", "split", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("can't find pane: new-session");
      return "ok";
    }, {
      attempts: 2,
      delayMs: 9,
      hasSession: async () => false,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });

    expect(result).toBe("ok");
    expect(sleeps).toContain(9);
  });

  test("maybeSplit continues when Claude-like pane probing fails", async () => {
    const { maybeSplit } = await import("../../src/commands/shared/wake-maybe-split.ts?coverage-100b-split");
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%11";
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("display-message")) throw new Error("probe failed");
      if (cmd.includes("show-options")) return "1";
      return "";
    };
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    await maybeSplit("agent:0", { split: true });

    expect(hostExecCalls.some(cmd => cmd.includes("display-message"))).toBe(true);
    expect(hostExecCalls.some(cmd => cmd.includes("split-window"))).toBe(true);
    expect(logs.join("\n")).toContain("split beside");
  });
});

describe("workspace store error branches", () => {
  test("loadWorkspace returns null for malformed JSON", async () => {
    const configDir = tmp("maw-workspaces-bad-file-");
    process.env.MAW_CONFIG_DIR = configDir;
    const store = await import("../../src/commands/shared/workspace-store.ts?coverage-100b-workspace-load");
    mkdirSync(join(configDir, "workspaces"), { recursive: true });
    writeFileSync(join(configDir, "workspaces", "bad.json"), "{ nope", "utf-8");

    expect(store.loadWorkspace("bad")).toBeNull();
  });

  test("loadAllWorkspaces skips malformed entries and catches unreadable workspace directory", async () => {
    const configDir = tmp("maw-workspaces-list-");
    process.env.MAW_CONFIG_DIR = configDir;
    const store = await import("../../src/commands/shared/workspace-store.ts?coverage-100b-workspace-list");
    mkdirSync(join(configDir, "workspaces"), { recursive: true });
    writeFileSync(join(configDir, "workspaces", "bad.json"), "{ nope", "utf-8");
    writeFileSync(join(configDir, "workspaces", "good.json"), JSON.stringify({
      id: "good",
      name: "Good",
      hubUrl: "http://hub",
      joinCode: "JOIN",
      sharedAgents: ["one", 7, "two"],
      joinedAt: "now",
      lastStatus: "connected",
    }), "utf-8");

    expect(store.loadAllWorkspaces()).toEqual([{
      id: "good",
      name: "Good",
      hubUrl: "http://hub",
      joinCode: "JOIN",
      sharedAgents: ["one", "two"],
      joinedAt: "now",
      lastStatus: "connected",
    }]);

    const blockedConfigDir = tmp("maw-workspaces-blocked-");
    process.env.MAW_CONFIG_DIR = blockedConfigDir;
    writeFileSync(join(blockedConfigDir, "workspaces"), "not a directory", "utf-8");
    const blockedStore = await import("../../src/commands/shared/workspace-store.ts?coverage-100b-workspace-blocked");
    expect(blockedStore.loadAllWorkspaces()).toEqual([]);
  });
});

describe("shared matching and fixer branches", () => {
  test("autoFix removes duplicate peer URLs", async () => {
    const { autoFix } = await import("../../src/commands/shared/fleet-doctor-fixer.ts?coverage-100b-fixer");
    const saves: unknown[] = [];

    const applied = autoFix([], {
      node: "local",
      port: 3000,
      namedPeers: [
        { name: "first", url: "http://peer:1" },
        { name: "second", url: "http://peer:1" },
      ],
      agents: {},
    } as any, (update) => saves.push(update));

    expect(applied).toEqual(["removed duplicate peer URL 'http://peer:1' (was 'second')"]);
    expect(saves).toEqual([{ namedPeers: [{ name: "first", url: "http://peer:1" }], agents: {} }]);
  });

  test("resolvePaneTargetFromCandidates delegates fuzzy and ambiguous matches", async () => {
    const { resolvePaneTargetFromCandidates } = await import("../../src/commands/shared/pane-target-resolver.ts?coverage-100b-pane-resolver");
    const candidates = [
      { name: "fleet-alpha", resolved: "%1", source: "pane-title", target: "s:1.1" },
      { name: "one-view", resolved: "%2", source: "pane-title", target: "s:1.2" },
      { name: "two-view", resolved: "%3", source: "pane-title", target: "s:1.3" },
    ];

    expect(resolvePaneTargetFromCandidates("alpha", candidates)).toEqual({ kind: "match", candidate: candidates[0] });
    expect(resolvePaneTargetFromCandidates("view", candidates)).toEqual({ kind: "ambiguous", candidates: [candidates[1], candidates[2]] });
  });
});
