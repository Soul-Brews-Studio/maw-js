import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const root = join(import.meta.dir, "../..");

type Session = { name: string; windows: Array<{ index: number; name: string; active?: boolean }> };
let sessions: Session[] = [];
let tmuxRunImpl: (...args: string[]) => string | Promise<string> = () => "";
let hostExecImpl: (cmd: string) => string | Promise<string> = () => "";
let killedWindows: string[] = [];
let savedOrders: string[] = [];
let sentLiteral: Array<[string, string]> = [];
let sentKeys: Array<[string, string]> = [];
let listedWindows: Record<string, Array<{ name: string }>> = {};
let killedSleepWindows: string[] = [];
let snapshots: string[] = [];

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => await hostExecImpl(cmd),
  tmuxCmd: () => "tmux",
  tmux: {
    run: async (...args: string[]) => await tmuxRunImpl(...args),
    killWindow: async (target: string) => { killedWindows.push(target); },
    sendKeysLiteral: async (target: string, text: string) => { sentLiteral.push([target, text]); },
    sendKeys: async (target: string, key: string) => { sentKeys.push([target, key]); },
    listWindows: async (session: string) => listedWindows[session] ?? [],
  },
  saveTabOrder: async (session: string) => { savedOrders.push(session); },
  takeSnapshot: (name: string) => { snapshots.push(name); return Promise.resolve(); },
  curlFetch: async () => ({ ok: true, data: { ok: true } }),
  resolveTarget: () => null,
  FLEET_DIR: "/tmp/fleet",
  attachRemoteSession: async () => undefined,
  resolveSocket: () => "default",
  Tmux: class {
    async run(...args: string[]) { return await tmuxRunImpl(...args); }
    async sendKeysLiteral(target: string, text: string) { sentLiteral.push([target, text]); }
    async sendKeys(target: string, key: string) { sentKeys.push([target, key]); }
    async listWindows(session: string) { return listedWindows[session] ?? []; }
    async killWindow(target: string) { killedWindows.push(target); }
  },
}));

mock.module("maw-js/config/ghq-root", () => ({ getGhqRoot: () => "/tmp/ghq" }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/done-autosave.ts"), () => ({
  signalParentInbox: async () => undefined,
  autoSave: async () => undefined,
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/done-worktree.ts"), () => ({
  removeWorktreeViaConfig: async () => false,
  removeWorktreeByGhqScan: async () => false,
  removeFromFleetConfig: () => false,
}));
mock.module("maw-js/plugin/lifecycle", () => ({ runSleepLifecycleHooks: async () => undefined, runWakeLifecycleHooks: async () => undefined }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/sleep/resolve-target.ts"), () => ({
  resolveSleepTarget: async (target: string) => target === "known" ? { session: "s1", window: "worker--" } : null,
}));

const tokenLib = await import("../../src/vendor/mpr-plugins/token/lib");
const tokenScan = await import("../../src/vendor/mpr-plugins/token/scan");
const doneImpl = await import("../../src/vendor/mpr-plugins/done/impl.ts?coverage-100b-vendor-c-core");
const doneReunion = await import("../../src/vendor/mpr-plugins/done/internal/reunion-impl.ts?coverage-100b-vendor-c-core");
const reunionImpl = await import("../../src/vendor/mpr-plugins/reunion/impl.ts?coverage-100b-vendor-c-core");
const trustStore = await import("../../src/vendor/mpr-plugins/trust/store.ts?coverage-100b-vendor-c-core");

const created: string[] = [];
const originalEnv = { ...process.env };
const originalConsole = { log: console.log, error: console.error, warn: console.warn };

function tmp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function runResult(ok: boolean, stdout = "", stderr = "", exitCode = ok ? 0 : 1) {
  return { ok, stdout, stderr, exitCode };
}
async function capture<T>(fn: () => T | Promise<T>) {
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
  }
}

beforeEach(() => {
  sessions = [];
  tmuxRunImpl = () => "";
  hostExecImpl = () => "";
  killedWindows = [];
  killedSleepWindows = [];
  savedOrders = [];
  sentLiteral = [];
  sentKeys = [];
  listedWindows = {};
  snapshots = [];
  tokenLib.setRunOverride(null);
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
});

afterEach(() => {
  tokenLib.setRunOverride(null);
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  process.env = { ...originalEnv };
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coverage-100b vendor/core direct gaps", () => {
  test("token scan skips stat/read failures without surfacing token material", () => {
    const sandbox = tmp("maw-token-scan-gaps-");
    const ghqRoot = join(sandbox, "ghq");
    const githubRoot = join(ghqRoot, "github.com");
    const home = join(sandbox, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(githubRoot, "org", "repo"), { recursive: true });
    symlinkSync(join(sandbox, "missing"), join(githubRoot, "dangling"));
    write(join(githubRoot, "org", "repo", ".envrc"), "export CLAUDE_CODE_OAUTH_TOKEN=secret-token-value\n");
    chmodSync(join(githubRoot, "org", "repo", ".envrc"), 0o000);

    expect(tokenScan.findEnvrcFiles(githubRoot, home)).toEqual([
      { label: "org/repo", path: join(githubRoot, "org", "repo", ".envrc") },
    ]);

    tokenLib.setRunOverride((cmd: string[]) => {
      if (cmd[0] === "ghq" && cmd[1] === "root") return runResult(true, `${ghqRoot}\n`);
      if (cmd[0] === "pass" && cmd[1] === "ls") return runResult(true, "token-a\n");
      if (cmd[0] === "pass" && cmd[1] === "show") return runResult(true, "secret-token-value\n");
      return runResult(false, "", `unexpected ${cmd.join(" ")}`);
    });

    const scan = tokenScan.cmdScan({ home });
    expect(scan).toMatchObject({ ok: true, ghqRoot: githubRoot, rows: [] });
  });

  test("done --all refuses stale current-session names", async () => {
    sessions = [{ name: "actual", windows: [{ index: 0, name: "lead" }] }, { name: "other", windows: [{ index: 0, name: "lead" }] }];
    tmuxRunImpl = () => "stale\n";

    const out = await capture(() => doneImpl.cmdDoneAll({ dryRun: true }));

    expect(out.result).toEqual({ sessionName: null, processed: [], skipped: [] });
    expect(out.logs.join("\n")).toContain("could not identify current tmux session");
  });

  test("reunion implementations handle missing current tmux cwd", async () => {
    hostExecImpl = () => { throw new Error("no tmux"); };

    const a = await capture(() => doneReunion.cmdReunion());
    const b = await capture(() => reunionImpl.cmdReunion());

    expect(a.result).toBeNull();
    expect(b.result).toBeNull();
    expect(a.logs.join("\n")).toContain("not in tmux");
    expect(b.logs.join("\n")).toContain("not in tmux");
  });

  test("trust store treats unreadable and malformed trust files as empty", () => {
    const dir = tmp("maw-trust-store-gaps-");
    process.env.MAW_CONFIG_DIR = join(dir, "config");
    process.env.MAW_STATE_DIR = join(dir, "state");
    mkdirSync(trustStore.trustPath(), { recursive: true });
    expect(trustStore.loadTrust()).toEqual([]);
    rmSync(trustStore.trustPath(), { recursive: true, force: true });
    write(trustStore.trustPath(), "{not json");
    expect(trustStore.loadTrust()).toEqual([]);
  });

});
