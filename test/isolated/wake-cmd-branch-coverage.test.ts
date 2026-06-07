import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let mockActive = false;

const _rSdk = await import("../../src/sdk");
const _rConfig = await import("../../src/config");
const _rWakeResolve = await import("../../src/commands/shared/wake-resolve");
const _rWakeSession = await import("../../src/commands/shared/wake-session");
const _rWakeMaybeSplit = await import("../../src/commands/shared/wake-maybe-split");
const _rLifecycle = await import("../../src/plugin/lifecycle");
const _rWakeTarget = await import("../../src/commands/shared/wake-target");
const _rConcurrency = await import("../../src/commands/shared/wake-concurrency");
const _rSnapshot = await import("../../src/core/fleet/snapshot");
const _rClaudeSessions = await import("../../src/core/fleet/claude-sessions");
const _rShouldAutoWake = await import("../../src/commands/shared/should-auto-wake");
const _rTeamEnsure = await import("../../src/commands/plugins/team/ensure-config");
const _rGhq = await import("../../src/core/ghq");

const realSdk = {
  ..._rSdk,
  tmux: {
    hasSession: _rSdk.tmux.hasSession.bind(_rSdk.tmux),
    listSessions: _rSdk.tmux.listSessions.bind(_rSdk.tmux),
    listWindows: _rSdk.tmux.listWindows.bind(_rSdk.tmux),
    newSession: _rSdk.tmux.newSession.bind(_rSdk.tmux),
    newWindow: _rSdk.tmux.newWindow.bind(_rSdk.tmux),
    sendText: _rSdk.tmux.sendText.bind(_rSdk.tmux),
    selectWindow: _rSdk.tmux.selectWindow.bind(_rSdk.tmux),
    setEnvironment: _rSdk.tmux.setEnvironment.bind(_rSdk.tmux),
  },
};
const realConfig = { ..._rConfig };
const realWakeResolve = { ..._rWakeResolve };
const realWakeSession = { ..._rWakeSession };
const realWakeMaybeSplit = { ..._rWakeMaybeSplit };
const realLifecycle = { ..._rLifecycle };
const realWakeTarget = { ..._rWakeTarget };
const realConcurrency = { ..._rConcurrency };
const realSnapshot = { ..._rSnapshot };
const realClaudeSessions = { ..._rClaudeSessions };
const realShouldAutoWake = { ..._rShouldAutoWake };
const realTeamEnsure = { ..._rTeamEnsure };
const realGhq = { ..._rGhq };

type WindowInfo = { name: string; index?: number; active?: boolean; cwd?: string };

let tempRoot = "";
let parentDir = "";
let repoName = "mawjs-oracle";
let repoPath = "";
let sessions: Array<{ name: string }> = [];
let windowsBySession: Record<string, WindowInfo[]> = {};
let hasSessions = new Set<string>();
let worktrees: Array<{ name: string; path: string }> = [];
let listWindowsThrows = false;
let listClaudeSessionsThrows = false;
let snapshot: any = null;
let shouldWakeDecision = { wake: false, reason: "already-live" };
let paneCommand = "codex";
let logs: string[] = [];
let writes: string[] = [];
let newWindowCalls: Array<{ session: string; name: string; opts: any }> = [];
let sendTextCalls: Array<{ target: string; text: string }> = [];
let selectWindowCalls: string[] = [];
let attachCalls: string[] = [];
let splitCalls: string[] = [];
let openWindowCalls: string[] = [];
let snapshotCalls: string[] = [];
let capacityCalls: string[] = [];

function resetState() {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-wake-cmd-branches-"));
  parentDir = tempRoot;
  repoName = "mawjs-oracle";
  repoPath = join(parentDir, repoName);
  sessions = [{ name: "54-mawjs" }];
  windowsBySession = {
    "54-mawjs": [{ name: "mawjs-oracle", index: 0, active: true, cwd: repoPath }],
  };
  hasSessions = new Set(["54-mawjs"]);
  worktrees = [];
  listWindowsThrows = false;
  listClaudeSessionsThrows = false;
  snapshot = null;
  shouldWakeDecision = { wake: false, reason: "already-live" };
  paneCommand = "codex";
  logs = [];
  writes = [];
  newWindowCalls = [];
  sendTextCalls = [];
  selectWindowCalls = [];
  attachCalls = [];
  splitCalls = [];
  openWindowCalls = [];
  snapshotCalls = [];
  capacityCalls = [];
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  logs = [];
  writes = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
}

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ..._rSdk,
  hostExec: async (cmd: string) => {
    if (!mockActive) return realSdk.hostExec(cmd);
    if (cmd.includes("list-panes")) return "";
    if (cmd.includes("branch --show-current")) return "main\n";
    return "";
  },
  restoreTabOrder: async (session: string) => mockActive ? 0 : realSdk.restoreTabOrder(session),
  takeSnapshot: async (trigger: string) => {
    if (!mockActive) return realSdk.takeSnapshot(trigger);
    snapshotCalls.push(trigger);
    return join(tempRoot, `${trigger}.json`);
  },
  getPaneInfos: async (targets: string[]) => mockActive
    ? Object.fromEntries(targets.map(target => [target, { command: paneCommand, cwd: repoPath }]))
    : realSdk.getPaneInfos(targets),
  isAgentCommand: (cmd: string | null | undefined) => mockActive ? ["claude", "codex", "node"].includes((cmd ?? "").trim()) : realSdk.isAgentCommand(cmd),
  tmux: {
    ..._rSdk.tmux,
    hasSession: async (name: string) => mockActive ? hasSessions.has(name) : realSdk.tmux.hasSession(name),
    listSessions: async () => mockActive ? sessions : realSdk.tmux.listSessions(),
    listWindows: async (session: string) => {
      if (!mockActive) return realSdk.tmux.listWindows(session);
      if (listWindowsThrows) throw new Error("tmux unavailable");
      return windowsBySession[session] ?? [];
    },
    newSession: async (name: string, opts: any = {}) => {
      if (!mockActive) return realSdk.tmux.newSession(name, opts);
      sessions.push({ name });
      hasSessions.add(name);
      windowsBySession[name] = opts.window ? [{ name: opts.window, cwd: opts.cwd }] : [];
    },
    newWindow: async (session: string, name: string, opts: any = {}) => {
      if (!mockActive) return realSdk.tmux.newWindow(session, name, opts);
      newWindowCalls.push({ session, name, opts });
      (windowsBySession[session] ??= []).push({ name, cwd: opts.cwd });
    },
    sendText: async (target: string, text: string) => {
      if (!mockActive) return realSdk.tmux.sendText(target, text);
      sendTextCalls.push({ target, text });
    },
    selectWindow: async (target: string) => {
      if (!mockActive) return realSdk.tmux.selectWindow(target);
      selectWindowCalls.push(target);
    },
    setEnvironment: async (...args: any[]) => {
      if (!mockActive) return (realSdk.tmux.setEnvironment as any)(...args);
    },
  },
}));

mock.module(join(import.meta.dir, "../../src/config"), () => ({
  ..._rConfig,
  buildCommandInDir: (windowName: string, cwd: string, engine?: string) => mockActive ? `cd ${cwd} && ${engine ?? "codex"} --agent ${windowName}` : realConfig.buildCommandInDir(windowName, cwd, engine),
  cfgTimeout: (key: any) => mockActive ? 0 : realConfig.cfgTimeout(key),
  loadConfig: () => mockActive ? { node: "m5", agents: { mawjs: "m5" } } : realConfig.loadConfig(),
  saveConfig: (patch: any) => mockActive ? undefined : realConfig.saveConfig(patch),
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-resolve"), () => ({
  ..._rWakeResolve,
  resolveOracle: async (...args: any[]) => mockActive ? { repoPath, repoName, parentDir } : (realWakeResolve.resolveOracle as any)(...args),
  findWorktrees: async (...args: any[]) => mockActive ? worktrees : (realWakeResolve.findWorktrees as any)(...args),
  findReusableWorktreeBySlug: (...args: any[]) => mockActive ? null : (realWakeResolve.findReusableWorktreeBySlug as any)(...args),
  getSessionMap: () => mockActive ? {} : realWakeResolve.getSessionMap(),
  resolveFleetSession: (oracle: string) => mockActive ? null : realWakeResolve.resolveFleetSession(oracle),
  detectSession: async (oracle: string) => mockActive ? "54-mawjs" : realWakeResolve.detectSession(oracle),
  setSessionEnv: async (session: string) => mockActive ? undefined : realWakeResolve.setSessionEnv(session),
  sanitizeBranchName: (value: string) => mockActive ? value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, 50) : realWakeResolve.sanitizeBranchName(value),
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-session"), () => ({
  ..._rWakeSession,
  attachToSession: async (session: string) => { if (!mockActive) return realWakeSession.attachToSession(session); attachCalls.push(session); },
  ensureSessionRunning: async (...args: any[]) => mockActive ? 0 : (realWakeSession.ensureSessionRunning as any)(...args),
  createWorktree: async (repoPathArg: string, parentDirArg: string, repoNameArg: string, oracle: string, name: string) => {
    if (!mockActive) return (realWakeSession.createWorktree as any)(repoPathArg, parentDirArg, repoNameArg, oracle, name);
    const wtPath = join(parentDirArg, `${repoNameArg}.wt-${name}`);
    return { wtPath, windowName: `${oracle}-${name}` };
  },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-maybe-split"), () => ({
  ..._rWakeMaybeSplit,
  maybeSplit: async (target: string, opts: any) => { if (!mockActive) return realWakeMaybeSplit.maybeSplit(target, opts); splitCalls.push(target); },
  maybeOpenWindow: async (target: string, opts: any) => { if (!mockActive) return realWakeMaybeSplit.maybeOpenWindow(target, opts); openWindowCalls.push(target); },
}));

mock.module(join(import.meta.dir, "../../src/plugin/lifecycle"), () => ({
  ..._rLifecycle,
  runWakeLifecycleHooks: async (...args: any[]) => mockActive ? { phase: "wake", ran: 0, skipped: 0, failed: 0 } : (realLifecycle.runWakeLifecycleHooks as any)(...args),
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-target"), () => ({
  ..._rWakeTarget,
  parseWakeTarget: (target: string) => mockActive ? null : realWakeTarget.parseWakeTarget(target),
  ensureCloned: async (slug: string) => { if (!mockActive) return realWakeTarget.ensureCloned(slug); },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-concurrency"), () => ({
  ..._rConcurrency,
  assertAgentCapacity: async (oracle: string) => { if (!mockActive) return realConcurrency.assertAgentCapacity(oracle); capacityCalls.push(oracle); },
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/snapshot"), () => ({
  ..._rSnapshot,
  latestSnapshot: () => mockActive ? snapshot : realSnapshot.latestSnapshot(),
  loadSnapshot: (id: string) => mockActive ? snapshot : realSnapshot.loadSnapshot(id),
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/claude-sessions"), () => ({
  ..._rClaudeSessions,
  listClaudeSessions: async () => {
    if (!mockActive) return realClaudeSessions.listClaudeSessions();
    if (listClaudeSessionsThrows) throw new Error("session scan failed");
    return [];
  },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/should-auto-wake"), () => ({
  ..._rShouldAutoWake,
  shouldAutoWake: (...args: any[]) => mockActive ? shouldWakeDecision : (realShouldAutoWake.shouldAutoWake as any)(...args),
}));

mock.module(join(import.meta.dir, "../../src/commands/plugins/team/ensure-config"), () => ({
  ..._rTeamEnsure,
  ensureTeamConfig: (name: string) => mockActive ? false : realTeamEnsure.ensureTeamConfig(name),
}));

mock.module(join(import.meta.dir, "../../src/core/ghq"), () => ({
  ..._rGhq,
  ghqFind: async (...args: any[]) => mockActive ? null : (realGhq.ghqFind as any)(...args),
}));

const { cmdWake, _wtPicker } = await import("../../src/commands/shared/wake-cmd");

beforeEach(() => {
  mockActive = true;
  resetState();
});

afterEach(() => {
  mockActive = false;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("wake-cmd isolated executable branch coverage", () => {
  test("list mode handles no worktrees even when Claude session discovery fails", async () => {
    listClaudeSessionsThrows = true;

    const { result, logs } = await captureLogs(() => cmdWake("mawjs", { listWt: true }));

    expect(result).toBe("mawjs:list");
    expect(logs.join("\n")).toContain("No worktrees for mawjs");
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
  });

  test("rejects invalid control combinations and target workspace names before tmux mutation", async () => {
    await expect(cmdWake("mawjs", { signalOnBirth: true })).rejects.toThrow("--signal-on-birth requires --bud");
    await expect(cmdWake("mawjs", { session: "bad/session" })).rejects.toThrow("invalid target session");

    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
  });

  test("rejects missing foreign workspace sessions", async () => {
    hasSessions = new Set();

    await expect(cmdWake("mawjs", { session: "project", noRehydrate: true })).rejects.toThrow("target session 'project' not found");

    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
  });

  test("rejects unavailable and non-matching requested snapshots", async () => {
    snapshot = null;
    await expect(cmdWake("mawjs", { fromSnapshot: true, snapshotId: "missing" })).rejects.toThrow("snapshot not found: missing");

    snapshot = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [{ name: "99-other", windows: [] }] };
    await expect(cmdWake("mawjs", { fromSnapshot: true })).rejects.toThrow("has no session for mawjs");
  });

  test("dry-run task preview reports wake-bud lineage and birth signal without creating windows", async () => {
    const { result, logs } = await captureLogs(() => cmdWake("mawjs", {
      task: "Birth Signal",
      bud: true,
      signalOnBirth: true,
      dryRun: true,
    }));

    expect(result).toBe("54-mawjs:mawjs-oracle");
    const rendered = logs.join("\n");
    expect(rendered).toContain("would wake worktree/task: birth-signal");
    expect(rendered).toContain("would stamp wake-bud lineage");
    expect(rendered).toContain("would drop wake-bud birth signal");
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
  });

  test("bring --pick can match a nested agents worktree cwd alias", async () => {
    windowsBySession = {
      "54-mawjs": [{ name: "scratch", index: 0, active: true, cwd: join(repoPath, "agents", "review-123") }],
    };
    const originalIsStdoutTTY = _wtPicker.isStdoutTTY;
    const originalReadChoice = _wtPicker.readChoice;
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1";

    try {
      const { result, logs } = await captureLogs(() => cmdWake("review-123", {
        bringAlias: true,
        session: "54-mawjs",
        pick: true,
        dryRun: true,
      }));

      expect(result).toBe("54-mawjs:scratch");
      const rendered = logs.join("\n");
      expect(rendered).toContain("live tmux window: 54-mawjs:scratch");
      expect(rendered).toContain("tmux window in 54-mawjs · oracle mawjs · worktree review-123");
      expect(newWindowCalls).toEqual([]);
    } finally {
      _wtPicker.isStdoutTTY = originalIsStdoutTTY;
      _wtPicker.readChoice = originalReadChoice;
    }
  });

  test("existing window with prompt selects, sends escaped prompt, attaches, splits, tabs, and snapshots", async () => {
    const { result } = await captureLogs(() => cmdWake("mawjs", {
      prompt: "say 'hi'",
      attach: true,
      split: true,
      tab: true,
    }));

    expect(result).toBe("54-mawjs:mawjs-oracle");
    expect(selectWindowCalls).toEqual(["54-mawjs:mawjs-oracle"]);
    expect(sendTextCalls).toHaveLength(1);
    expect(sendTextCalls[0]!.target).toBe("54-mawjs:mawjs-oracle");
    expect(sendTextCalls[0]!.text).toContain(`cd ${repoPath} && codex --agent mawjs-oracle -p `);
    expect(sendTextCalls[0]!.text).toMatch(/say .*hi/);
    expect(attachCalls).toEqual(["54-mawjs"]);
    expect(splitCalls).toEqual(["54-mawjs:mawjs-oracle"]);
    expect(openWindowCalls).toEqual(["54-mawjs:mawjs-oracle"]);
    expect(snapshotCalls).toEqual(["wake"]);
  });

  test("refuses to create a task window when existing window list is unreliable", async () => {
    listWindowsThrows = true;

    await expect(cmdWake("mawjs", { task: "new pane" })).rejects.toThrow("could not list windows for session '54-mawjs'");

    expect(capacityCalls).toEqual([]);
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
  });
});
