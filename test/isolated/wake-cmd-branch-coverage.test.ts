import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let mockActive = false;
// kobo-483: fail-closed, same pattern as wake-cmd-cmdwake-coverage.test.ts —
// see that file's header for the full rationale.
let suiteStarted = false;

function realCallForbidden(label: string): never {
  throw new Error(
    `[kobo-483 fail-closed] mockActive was false for "${label}" after the test suite ` +
    `had already started — refusing to fall through to the real implementation. ` +
    `Fix the race, don't restore the real passthrough.`,
  );
}

function resolveMock<T>(fake: () => T, real: () => T, label: string): T {
  if (mockActive) return fake();
  if (!suiteStarted) return real();
  return realCallForbidden(label);
}

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
let detectSessionResult: string | null = "54-mawjs";
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
  detectSessionResult = "54-mawjs";
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
    if (!mockActive) {
      if (!suiteStarted) return realSdk.hostExec(cmd);
      return realCallForbidden("hostExec");
    }
    if (cmd.includes("list-panes")) return "";
    if (cmd.includes("branch --show-current")) return "main\n";
    return "";
  },
  restoreTabOrder: async (session: string) => resolveMock(() => 0, () => realSdk.restoreTabOrder(session), "restoreTabOrder"),
  takeSnapshot: async (trigger: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realSdk.takeSnapshot(trigger);
      return realCallForbidden("takeSnapshot");
    }
    snapshotCalls.push(trigger);
    return join(tempRoot, `${trigger}.json`);
  },
  getPaneInfos: async (targets: string[]) => resolveMock(
    () => Object.fromEntries(targets.map(target => [target, { command: paneCommand, cwd: repoPath }])),
    () => realSdk.getPaneInfos(targets),
    "getPaneInfos",
  ),
  isAgentCommand: (cmd: string | null | undefined) => resolveMock(
    () => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
    () => realSdk.isAgentCommand(cmd),
    "isAgentCommand",
  ),
  tmux: {
    ..._rSdk.tmux,
    hasSession: async (name: string) => resolveMock(() => hasSessions.has(name), () => realSdk.tmux.hasSession(name), "tmux.hasSession"),
    listSessions: async () => resolveMock(() => sessions, () => realSdk.tmux.listSessions(), "tmux.listSessions"),
    listWindows: async (session: string) => {
      if (!mockActive) {
        if (!suiteStarted) return realSdk.tmux.listWindows(session);
        return realCallForbidden("tmux.listWindows");
      }
      if (listWindowsThrows) throw new Error("tmux unavailable");
      return windowsBySession[session] ?? [];
    },
    newSession: async (name: string, opts: any = {}) => {
      if (!mockActive) {
        if (!suiteStarted) return realSdk.tmux.newSession(name, opts);
        return realCallForbidden("tmux.newSession");
      }
      sessions.push({ name });
      hasSessions.add(name);
      windowsBySession[name] = opts.window ? [{ name: opts.window, cwd: opts.cwd }] : [];
    },
    newWindow: async (session: string, name: string, opts: any = {}) => {
      if (!mockActive) {
        if (!suiteStarted) return realSdk.tmux.newWindow(session, name, opts);
        return realCallForbidden("tmux.newWindow");
      }
      newWindowCalls.push({ session, name, opts });
      (windowsBySession[session] ??= []).push({ name, cwd: opts.cwd });
    },
    sendText: async (target: string, text: string) => {
      if (!mockActive) {
        if (!suiteStarted) return realSdk.tmux.sendText(target, text);
        return realCallForbidden("tmux.sendText");
      }
      sendTextCalls.push({ target, text });
    },
    selectWindow: async (target: string) => {
      if (!mockActive) {
        if (!suiteStarted) return realSdk.tmux.selectWindow(target);
        return realCallForbidden("tmux.selectWindow");
      }
      selectWindowCalls.push(target);
    },
    setEnvironment: async (...args: any[]) => {
      if (!mockActive) {
        if (!suiteStarted) return (realSdk.tmux.setEnvironment as any)(...args);
        return realCallForbidden("tmux.setEnvironment");
      }
    },
  },
}));

mock.module(join(import.meta.dir, "../../src/config"), () => ({
  ..._rConfig,
  buildCommandInDir: (windowName: string, cwd: string, engine?: string) => resolveMock(
    () => `cd ${cwd} && ${engine ?? "codex"} --agent ${windowName}`,
    () => realConfig.buildCommandInDir(windowName, cwd, engine),
    "buildCommandInDir",
  ),
  cfgTimeout: (key: any) => resolveMock(() => 0, () => realConfig.cfgTimeout(key), "cfgTimeout"),
  loadConfig: () => resolveMock(
    () => ({ node: "m5", agents: { mawjs: "m5" }, commands: { default: "claude" } }),
    () => realConfig.loadConfig(),
    "loadConfig",
  ),
  saveConfig: (patch: any) => resolveMock(() => undefined, () => realConfig.saveConfig(patch), "saveConfig"),
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-resolve"), () => ({
  ..._rWakeResolve,
  resolveOracle: async (...args: any[]) => resolveMock(
    () => ({ repoPath, repoName, parentDir }),
    () => (realWakeResolve.resolveOracle as any)(...args),
    "resolveOracle",
  ),
  findWorktrees: async (...args: any[]) => resolveMock(() => worktrees, () => (realWakeResolve.findWorktrees as any)(...args), "findWorktrees"),
  findReusableWorktreeBySlug: (...args: any[]) => resolveMock(
    () => null,
    () => (realWakeResolve.findReusableWorktreeBySlug as any)(...args),
    "findReusableWorktreeBySlug",
  ),
  getSessionMap: () => resolveMock(() => ({}), () => realWakeResolve.getSessionMap(), "getSessionMap"),
  resolveFleetSession: (oracle: string) => resolveMock(() => null, () => realWakeResolve.resolveFleetSession(oracle), "resolveFleetSession"),
  detectSession: async (oracle: string) => resolveMock(() => detectSessionResult, () => realWakeResolve.detectSession(oracle), "detectSession"),
  setSessionEnv: async (session: string) => resolveMock(() => undefined, () => realWakeResolve.setSessionEnv(session), "setSessionEnv"),
  sanitizeBranchName: (value: string) => resolveMock(
    () => value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, 50),
    () => realWakeResolve.sanitizeBranchName(value),
    "sanitizeBranchName",
  ),
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-session"), () => ({
  ..._rWakeSession,
  attachToSession: async (session: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realWakeSession.attachToSession(session);
      return realCallForbidden("attachToSession");
    }
    attachCalls.push(session);
  },
  ensureSessionRunning: async (...args: any[]) => resolveMock(() => 0, () => (realWakeSession.ensureSessionRunning as any)(...args), "ensureSessionRunning"),
  createWorktree: async (repoPathArg: string, parentDirArg: string, repoNameArg: string, oracle: string, name: string) => {
    if (!mockActive) {
      if (!suiteStarted) return (realWakeSession.createWorktree as any)(repoPathArg, parentDirArg, repoNameArg, oracle, name);
      return realCallForbidden("createWorktree");
    }
    const wtPath = join(parentDirArg, `${repoNameArg}.wt-${name}`);
    return { wtPath, windowName: `${oracle}-${name}` };
  },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-maybe-split"), () => ({
  ..._rWakeMaybeSplit,
  maybeSplit: async (target: string, opts: any) => {
    if (!mockActive) {
      if (!suiteStarted) return realWakeMaybeSplit.maybeSplit(target, opts);
      return realCallForbidden("maybeSplit");
    }
    splitCalls.push(target);
  },
  maybeOpenWindow: async (target: string, opts: any) => {
    if (!mockActive) {
      if (!suiteStarted) return realWakeMaybeSplit.maybeOpenWindow(target, opts);
      return realCallForbidden("maybeOpenWindow");
    }
    openWindowCalls.push(target);
  },
}));

mock.module(join(import.meta.dir, "../../src/plugin/lifecycle"), () => ({
  ..._rLifecycle,
  runWakeLifecycleHooks: async (...args: any[]) => resolveMock(
    () => ({ phase: "wake", ran: 0, skipped: 0, failed: 0 }),
    () => (realLifecycle.runWakeLifecycleHooks as any)(...args),
    "runWakeLifecycleHooks",
  ),
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-target"), () => ({
  ..._rWakeTarget,
  parseWakeTarget: (target: string) => resolveMock(() => null, () => realWakeTarget.parseWakeTarget(target), "parseWakeTarget"),
  ensureCloned: async (slug: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realWakeTarget.ensureCloned(slug);
      return realCallForbidden("ensureCloned");
    }
  },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-concurrency"), () => ({
  ..._rConcurrency,
  assertAgentCapacity: async (oracle: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realConcurrency.assertAgentCapacity(oracle);
      return realCallForbidden("assertAgentCapacity");
    }
    capacityCalls.push(oracle);
  },
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/snapshot"), () => ({
  ..._rSnapshot,
  latestSnapshot: () => resolveMock(() => snapshot, () => realSnapshot.latestSnapshot(), "latestSnapshot"),
  listSnapshots: () => resolveMock(
    () => (snapshot ? [{ file: "latest.json", timestamp: snapshot.timestamp ?? "latest" }] : []),
    () => realSnapshot.listSnapshots(),
    "listSnapshots",
  ),
  loadSnapshot: (id: string) => resolveMock(() => snapshot, () => realSnapshot.loadSnapshot(id), "loadSnapshot"),
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/claude-sessions"), () => ({
  ..._rClaudeSessions,
  listClaudeSessions: async () => {
    if (!mockActive) {
      if (!suiteStarted) return realClaudeSessions.listClaudeSessions();
      return realCallForbidden("listClaudeSessions");
    }
    if (listClaudeSessionsThrows) throw new Error("session scan failed");
    return [];
  },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/should-auto-wake"), () => ({
  ..._rShouldAutoWake,
  shouldAutoWake: (...args: any[]) => resolveMock(() => shouldWakeDecision, () => (realShouldAutoWake.shouldAutoWake as any)(...args), "shouldAutoWake"),
}));

mock.module(join(import.meta.dir, "../../src/commands/plugins/team/ensure-config"), () => ({
  ..._rTeamEnsure,
  ensureTeamConfig: (name: string) => resolveMock(() => false, () => realTeamEnsure.ensureTeamConfig(name), "ensureTeamConfig"),
}));

mock.module(join(import.meta.dir, "../../src/core/ghq"), () => ({
  ..._rGhq,
  ghqFind: async (...args: any[]) => resolveMock(() => null, () => (realGhq.ghqFind as any)(...args), "ghqFind"),
}));

const { cmdWake, _wtPicker } = await import("../../src/commands/shared/wake-cmd");

beforeEach(() => {
  mockActive = true;
  suiteStarted = true; // kobo-483: never reset — marks "past the safe module-load window"
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

  test("creates missing foreign workspace sessions", async () => {
    hasSessions = new Set();

    const result = await cmdWake("mawjs", { session: "project", noRehydrate: true });

    expect(result).toBe("project:mawjs");
    expect(sessions).toContainEqual({ name: "project" });
    expect(windowsBySession.project).toEqual([{ name: "mawjs", cwd: repoPath }]);
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([{ target: "project:mawjs", text: expect.stringContaining("--agent mawjs") }]);
  });

  test("#2586 prompts before rehydrating saved agent windows in a newly created session", async () => {
    detectSessionResult = null;
    sessions = [];
    hasSessions = new Set();
    shouldWakeDecision = { wake: true, reason: "missing-session" };
    worktrees = [
      { name: "1-review", path: join(repoPath, "agents", "1-review") },
    ];
    const originalIsStdoutTTY = _wtPicker.isStdoutTTY;
    const originalReadChoice = _wtPicker.readChoice;
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "n";

    try {
      const { result, logs } = await captureLogs(() => cmdWake("mawjs", {}));

      expect(result).toBe("01-mawjs:mawjs-oracle");
      const rendered = logs.join("\n");
      expect(rendered).toContain("found 1 saved agent window");
      expect(writes.join("")).toContain("Rehydrate? [Y]es all / [n]one / [s]elect:");
      expect(rendered).toContain("skipped agent rehydration");
      expect(sessions).toContainEqual({ name: "01-mawjs" });
      expect(windowsBySession["01-mawjs"]).toEqual([{ name: "mawjs-oracle", cwd: repoPath }]);
      expect(newWindowCalls).toEqual([]);
      expect(sendTextCalls).toEqual([{ target: "01-mawjs:mawjs-oracle", text: expect.stringContaining("--agent mawjs-oracle") }]);
    } finally {
      _wtPicker.isStdoutTTY = originalIsStdoutTTY;
      _wtPicker.readChoice = originalReadChoice;
    }
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
    expect(sendTextCalls).toHaveLength(2);
    expect(sendTextCalls[0]!.target).toBe("54-mawjs:mawjs-oracle");
    expect(sendTextCalls[0]!.text).toContain(`cd ${repoPath}`);
    expect(sendTextCalls[1]!.target).toBe("54-mawjs:mawjs-oracle");
    expect(sendTextCalls[1]!.text).toMatch(/say .*hi/);
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
