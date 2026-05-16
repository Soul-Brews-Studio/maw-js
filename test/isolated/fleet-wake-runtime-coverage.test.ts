/** Runtime coverage for cmdSleep/cmdWakeAll without real tmux or fleet state. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface FleetSession { name: string; windows: Array<{ name: string; repo: string }>; skip_command?: boolean }

const fixedFleetDir = mkdtempSync(join(tmpdir(), "maw-fleet-fixed-"));
let fleetDir = fixedFleetDir;
let ghqRoot = "";
let sessions: FleetSession[] = [];
let logs: string[] = [];
let stderr: string[] = [];
let stdoutWrites: string[] = [];
let saveOrderCalls: string[] = [];
let restoreOrderResults = new Map<string, number | Error>();
let killFailures = new Set<string>();
let killed: string[] = [];
let hasSessions = new Set<string>();
let newSessions: unknown[][] = [];
let newWindows: unknown[][] = [];
let newWindowErrors = new Map<string, Error>();
let selected: string[] = [];
let sentText: string[] = [];
let envSets: unknown[][] = [];
let pinSessions: string[] = [];
let pinWindows: string[] = [];
let ensureResults = new Map<string, number | Error>();
let respawnCalls: unknown[] = [];
let respawnReturn = 0;
let resumeCalls = 0;
let failsoftWarnings: string[] = [];
let remoteSkipped = 0;
let created: string[] = [];

const originalLog = console.log;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalSetTimeout = globalThis.setTimeout;

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  FLEET_DIR: fixedFleetDir,
  saveTabOrder: async (name: string) => { saveOrderCalls.push(name); },
  restoreTabOrder: async (name: string) => {
    const result = restoreOrderResults.get(name) ?? 0;
    if (result instanceof Error) throw result;
    return result;
  },
  tmux: {
    killSession: async (name: string) => {
      if (killFailures.has(name)) throw new Error("missing session");
      killed.push(name);
    },
    hasSession: async (name: string) => hasSessions.has(name),
    newSession: async (...args: unknown[]) => { newSessions.push(args); },
    setEnvironment: async (...args: unknown[]) => { envSets.push(args); },
    sendText: async (target: string, command: string) => { sentText.push(`${target}=${command}`); },
    newWindow: async (session: string, name: string, opts: unknown) => {
      const key = `${session}:${name}`;
      const err = newWindowErrors.get(key);
      if (err) throw err;
      newWindows.push([session, name, opts]);
    },
    selectWindow: async (target: string) => { selected.push(target); },
  },
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  buildCommand: (name: string) => `run-${name}`,
  getEnvVars: () => ({ A: "1", B: "2" }),
}));

mock.module(import.meta.resolve("../../src/config/ghq-root"), () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-load"), () => ({
  loadFleet: () => sessions,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake"), () => ({
  ensureSessionRunning: async (name: string) => {
    const result = ensureResults.get(name) ?? 0;
    if (result instanceof Error) throw result;
    return result;
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-resume"), () => ({
  respawnMissingWorktrees: async (arg: unknown) => { respawnCalls.push(arg); return respawnReturn; },
  resumeActiveItems: async () => { resumeCalls += 1; },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-pane-size"), () => ({
  pinSessionWide: async (name: string) => { pinSessions.push(name); },
  pinWindowWide: async (target: string) => { pinWindows.push(target); },
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-wake-failsoft"), () => ({
  firstStderrLine: (text: string) => text.split("\n")[0],
  isSshTransportError: (err: unknown) => err instanceof Error && err.message.includes("SSH"),
  runWakeLoopFailSoft: async (steps: Array<{ sessName: string; run: () => Promise<void> }>) => {
    remoteSkipped = 0;
    failsoftWarnings = [];
    for (const step of steps) {
      try { await step.run(); }
      catch (err) {
        if (err instanceof Error && err.message.includes("SSH")) remoteSkipped += 1;
        failsoftWarnings.push(`${step.sessName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { remoteSkipped, warnings: failsoftWarnings };
  },
}));

const { cmdSleep, cmdWakeAll } = await import("../../src/commands/shared/fleet-wake.ts?fleet-wake-runtime-coverage");

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function repo(slug: string) {
  const dir = join(ghqRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".keep"), "x");
  return dir;
}

beforeEach(() => {
  rmSync(fixedFleetDir, { recursive: true, force: true });
  mkdirSync(fixedFleetDir, { recursive: true });
  fleetDir = fixedFleetDir;
  ghqRoot = tempDir("maw-ghq-");
  sessions = [];
  logs = [];
  stderr = [];
  stdoutWrites = [];
  saveOrderCalls = [];
  restoreOrderResults = new Map();
  killFailures = new Set();
  killed = [];
  hasSessions = new Set();
  newSessions = [];
  newWindows = [];
  newWindowErrors = new Map();
  selected = [];
  sentText = [];
  envSets = [];
  pinSessions = [];
  pinWindows = [];
  ensureResults = new Map();
  respawnCalls = [];
  respawnReturn = 0;
  resumeCalls = 0;
  failsoftWarnings = [];
  remoteSkipped = 0;
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
  (process.stdout as any).write = (chunk: unknown) => { stdoutWrites.push(String(chunk)); return true; };
  (process.stderr as any).write = (chunk: unknown) => { stderr.push(String(chunk)); return true; };
  (globalThis as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
    fn(...args);
    return 0;
  };
});

afterAll(() => {
  if (existsSync(fixedFleetDir)) rmSync(fixedFleetDir, { recursive: true, force: true });
});

afterEach(() => {
  console.log = originalLog;
  (process.stdout as any).write = originalStdoutWrite;
  (process.stderr as any).write = originalStderrWrite;
  (globalThis as any).setTimeout = originalSetTimeout;
  for (const dir of created.splice(0)) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("fleet wake runtime", () => {
  test("cmdSleep saves tab order, ignores missing sessions, and reports killed count", async () => {
    sessions = [
      { name: "01-one", windows: [{ name: "one", repo: "org/one" }] },
      { name: "02-missing", windows: [{ name: "two", repo: "org/two" }] },
    ];
    killFailures.add("02-missing");

    await cmdSleep();

    expect(saveOrderCalls).toEqual(["01-one", "02-missing"]);
    expect(killed).toEqual(["01-one"]);
    expect(logs.join("\n")).toContain("1 sessions put to sleep");
  });

  test("cmdWakeAll runs wake, fail-soft, verify, reorder, respawn, and resume paths", async () => {
    repo("org/one"); repo("org/two"); repo("org/ssh"); repo("org/sys");
    writeFileSync(join(fleetDir, "old.disabled"), "x");
    sessions = [
      { name: "01-main", windows: [
        { name: "main", repo: "org/one" },
        { name: "two", repo: "org/two" },
        { name: "missing", repo: "org/missing" },
      ] },
      { name: "02-ssh", windows: [
        { name: "ssh-main", repo: "org/ssh" },
        { name: "ssh-win", repo: "org/ssh" },
      ] },
      { name: "20-dormant", windows: [{ name: "sleep", repo: "org/sleep" }] },
      { name: "99-system", windows: [{ name: "sys", repo: "org/sys" }] },
    ];
    hasSessions.add("99-system");
    newWindowErrors.set("02-ssh:ssh-win", new Error("SSH transport down"));
    ensureResults.set("01-main", 1);
    ensureResults.set("02-ssh", new Error("SSH verify down"));
    restoreOrderResults.set("01-main", 1);
    restoreOrderResults.set("02-ssh", new Error("SSH restore down"));
    restoreOrderResults.set("99-system", 2);
    respawnReturn = 2;

    await cmdWakeAll({ kill: true, resume: true });

    expect(killed).toEqual(["01-main", "02-ssh", "20-dormant", "99-system"]);
    expect(newSessions.map((args) => args[0])).toEqual(["01-main", "02-ssh"]);
    expect(pinSessions).toEqual(["01-main", "02-ssh"]);
    expect(envSets).toEqual([
      ["01-main", "A", "1"], ["01-main", "B", "2"],
      ["02-ssh", "A", "1"], ["02-ssh", "B", "2"],
    ]);
    expect(sentText).toContain("01-main:main=run-main");
    expect(sentText).toContain("01-main:two=run-two");
    expect(sentText).toContain("02-ssh:ssh-main=run-ssh-main");
    expect(newWindows).toEqual([["01-main", "two", { cwd: join(ghqRoot, "org/two") }]]);
    expect(pinWindows).toEqual(["01-main:two"]);
    expect(stderr.join("\n")).toContain("skipping 01-main:missing");
    expect(selected).toEqual(["01-main:1"]);
    expect(respawnCalls[0]).toEqual([sessions[0], sessions[1], sessions[3]]);
    expect(resumeCalls).toBe(1);
    expect(stdoutWrites.join("\n")).toContain("02-ssh...");
    expect(logs.join("\n")).toContain("1 dormant skipped");
    expect(logs.join("\n")).toContain("1 window(s) retried");
    expect(logs.join("\n")).toContain("↻ 3 window(s) reordered");
    expect(logs.join("\n")).toContain("1 sessions, 5 windows woke up");
    expect(logs.join("\n")).toContain("1 remote skipped");
    expect(failsoftWarnings).toEqual(["02-ssh: SSH transport down"]);
  });

  test("cmdWakeAll all-mode includes dormant skip-command sessions and reports all-running", async () => {
    repo("org/sleep");
    sessions = [{ name: "20-dormant", skip_command: true, windows: [{ name: "sleep", repo: "org/sleep" }] }];

    await cmdWakeAll({ all: true });

    expect(newSessions.map((args) => args[0])).toEqual(["20-dormant"]);
    expect(sentText).toEqual([]);
    expect(logs.join("\n")).toContain("✓ All windows running");
    expect(logs.join("\n")).toContain("1 sessions, 1 windows woke up");
  });

  test("missing first-window cwd is surfaced through the fail-soft warning path", async () => {
    sessions = [{ name: "01-bad", windows: [{ name: "main", repo: "org/missing" }] }];

    await cmdWakeAll();

    expect(logs.join("\n")).toContain("refusing to spawn 01-bad");
    expect(newSessions).toEqual([]);
    expect(logs.join("\n")).toContain("0 sessions, 0 windows woke up");
  });
});
