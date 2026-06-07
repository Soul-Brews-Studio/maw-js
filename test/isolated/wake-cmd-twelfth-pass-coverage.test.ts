import { beforeEach, describe, expect, mock, test } from "bun:test";

const repoPath = "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle";
const parentDir = "/tmp/ghq/github.com/Soul-Brews-Studio";
const repoName = "neo-oracle";

type WindowInfo = { name: string };
type WorktreeInfo = { name: string; path: string };

let logs: string[] = [];
let stdoutWrites: string[] = [];
let listSessionsReturn: Array<{ name: string }> = [];
let detectSessionReturn: string | null = "54-neo";
let shouldWake = false;
let listWindowsReturn: WindowInfo[] = [];
let findWorktreesReturn: WorktreeInfo[] = [];
let claudeSessionsReturn: any[] = [];
let claudeSessionsThrows = false;
let snapshotReturn: any = null;
let paneCommand: string | null = "codex";
let capacityChecks: string[] = [];
let newWindows: Array<{ session: string; window: string; opts: any }> = [];
let sentText: Array<{ target: string; text: string }> = [];
let selectedWindows: string[] = [];
let attachCalls: string[] = [];
let splitCalls: string[] = [];
let openCalls: string[] = [];
let snapshots: string[] = [];
let worktreeCreates: any[] = [];

function resetState(): void {
  logs = [];
  stdoutWrites = [];
  listSessionsReturn = [];
  detectSessionReturn = "54-neo";
  shouldWake = false;
  listWindowsReturn = [{ name: "neo-oracle" }];
  findWorktreesReturn = [];
  claudeSessionsReturn = [];
  claudeSessionsThrows = false;
  snapshotReturn = null;
  paneCommand = "codex";
  capacityChecks = [];
  newWindows = [];
  sentText = [];
  selectedWindows = [];
  attachCalls = [];
  splitCalls = [];
  openCalls = [];
  snapshots = [];
  worktreeCreates = [];
}

async function captureLogs<T>(fn: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
}

function plain(): string {
  return logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    return "";
  },
  restoreTabOrder: async () => 0,
  takeSnapshot: async (trigger: string) => { snapshots.push(trigger); },
  getPaneInfos: async (targets: string[]) => Object.fromEntries(
    targets.map((target) => [target, { command: paneCommand }]),
  ),
  isAgentCommand: (command: string | null | undefined) => command === "codex" || command === "claude",
  tmux: {
    hasSession: async () => true,
    listSessions: async () => listSessionsReturn,
    listWindows: async () => listWindowsReturn,
    newSession: async () => {},
    newWindow: async (session: string, window: string, opts: any) => { newWindows.push({ session, window, opts }); },
    sendText: async (target: string, text: string) => { sentText.push({ target, text }); },
    selectWindow: async (target: string) => { selectedWindows.push(target); },
    setEnvironment: async () => {},
  },
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async () => null,
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  buildCommandInDir: (windowName: string, cwd: string, engine?: string) =>
    `cd ${cwd} && ${engine ?? "codex"} --agent ${windowName}`,
  cfgTimeout: () => 0,
  loadConfig: () => ({ node: "m5", agents: { neo: "m5" } }),
  saveConfig: () => {},
}));

mock.module(import.meta.resolve("../../src/core/fleet/validate"), () => ({
  assertValidOracleName: () => {},
}));

mock.module(import.meta.resolve("../../src/core/fleet/claude-sessions"), () => ({
  listClaudeSessions: async () => {
    if (claudeSessionsThrows) throw new Error("session scan failed");
    return claudeSessionsReturn;
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-resolve"), () => ({
  resolveOracle: async () => ({ repoPath, repoName, parentDir }),
  findWorktrees: async () => findWorktreesReturn,
  findReusableWorktreeBySlug: () => null,
  getSessionMap: () => ({}),
  resolveFleetSession: () => null,
  detectSession: async () => detectSessionReturn,
  setSessionEnv: async () => {},
  sanitizeBranchName: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^$/, "task"),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-session"), () => ({
  attachToSession: async (session: string) => { attachCalls.push(session); },
  reconcileParentClaudeDir: async () => {},
  ensureSessionRunning: async () => 0,
  createWorktree: async (...args: any[]) => {
    worktreeCreates.push(args);
    return { wtPath: "/tmp/neo-oracle.wt-fresh", windowName: "neo-fresh" };
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-maybe-split"), () => ({
  maybeOpenWindow: async (target: string) => { openCalls.push(target); },
  maybeSplit: async (target: string) => { splitCalls.push(target); },
}));

mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runWakeLifecycleHooks: async () => ({ phase: "wake", ran: 0, skipped: 0, failed: 0 }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-target"), () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => {},
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-concurrency"), () => ({
  assertAgentCapacity: async (oracle: string) => { capacityChecks.push(oracle); },
}));

mock.module(import.meta.resolve("../../src/core/fleet/snapshot"), () => ({
  latestSnapshot: () => null,
  loadSnapshot: () => snapshotReturn,
}));

mock.module(import.meta.resolve("../../src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: shouldWake, reason: shouldWake ? "missing" : "already-live" }),
}));

const { cmdWake, _wtPicker } = await import(
  "../../src/commands/shared/wake-cmd.ts?wake-cmd-twelfth-pass-coverage"
);

beforeEach(resetState);

describe("wake-cmd twelfth-pass isolated coverage", () => {
  test("TTY picker default hooks are safe in non-interactive tests", () => {
    expect(typeof _wtPicker.isStdoutTTY()).toBe("boolean");
    expect(_wtPicker.readChoice()).toBeNull();
  });

  test("list mode survives Claude session scan failures and still prints worktrees", async () => {
    findWorktreesReturn = [{ name: "8-ancient", path: "/tmp/neo-oracle.wt-8-ancient" }];
    claudeSessionsThrows = true;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, listWt: true }));

    expect(result).toBe("neo:list");
    expect(plain()).toContain("Worktrees for neo (1)");
    expect(plain()).toContain("8-ancient");
    expect(plain()).not.toContain("msgs");
  });

  test("list mode renders day-scale Claude session ages", async () => {
    findWorktreesReturn = [{ name: "8-ancient", path: "/tmp/neo-oracle.wt-8-ancient" }];
    claudeSessionsReturn = [{
      projectPath: "/tmp/neo-oracle.wt-8-ancient",
      status: "idle",
      lastActivityAt: "2026-05-10T00:00:00.000Z",
      messageCount: 1,
    }];

    const result = await captureLogs(() => cmdWake("neo", { repoPath, listWt: true }));

    expect(result).toBe("neo:list");
    expect(plain()).toContain("idle · 1 msg · last");
    expect(plain()).toContain("d ago");
  });

  test("dry-run with an explicit snapshot id reports no missing windows", async () => {
    snapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [{ name: "54-neo", windows: [] }] };
  
    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, dryRun: true, fromSnapshot: true, snapshotId: "snap-1" }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(plain()).toContain("would restore snapshot windows: none");
    expect(plain()).toContain("would respawn: none");
  });

  test("existing suffixed windows with dead agents are relaunched and attached", async () => {
    listWindowsReturn = [{ name: "neo-2-oracle" }];
    paneCommand = "zsh";

    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, attach: true, noRehydrate: true, engine: "claude" }),
    );

    expect(result).toBe("54-neo:neo-2-oracle");
    expect(sentText).toContainEqual({
      target: "54-neo:neo-2-oracle",
      text: `cd ${repoPath} && claude --agent neo-2-oracle`,
    });
    expect(selectedWindows).toEqual(["54-neo:neo-2-oracle"]);
    expect(attachCalls).toEqual(["54-neo"]);
    expect(splitCalls).toEqual(["54-neo:neo-2-oracle"]);
    expect(openCalls).toEqual(["54-neo:neo-2-oracle"]);
    expect(snapshots).toEqual(["wake"]);
    expect(plain()).toContain("agent dead, re-launching");
  });

  test("ambiguous worktree matches fail loudly when no interactive pick is available", async () => {
    findWorktreesReturn = [
      { name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" },
      { name: "2-alpha", path: "/tmp/neo-oracle.wt-2-alpha" },
    ];
    const originalIsTTY = _wtPicker.isStdoutTTY;
    try {
      _wtPicker.isStdoutTTY = () => false;
      await expect(captureLogs(() => cmdWake("neo", { repoPath, task: "alpha" }))).rejects.toThrow(
        "'alpha' is ambiguous",
      );
    } finally {
      _wtPicker.isStdoutTTY = originalIsTTY;
    }
  });

  test("new task worktrees without prompts launch the plain agent command", async () => {
    findWorktreesReturn = [];

    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, task: "fresh", fresh: true, engine: "claude" }),
    );

    expect(result).toBe("54-neo:neo-fresh");
    expect(worktreeCreates.length).toBe(1);
    expect(capacityChecks).toEqual(["neo"]);
    expect(newWindows).toEqual([{ session: "54-neo", window: "neo-fresh", opts: { cwd: "/tmp/neo-oracle.wt-fresh" } }]);
    expect(sentText.at(-1)).toEqual({
      target: "54-neo:neo-fresh",
      text: "cd /tmp/neo-oracle.wt-fresh && claude --agent neo-fresh",
    });
    expect(snapshots).toEqual(["wake"]);
    expect(plain()).toContain("woke 'neo-fresh'");
  });
});
