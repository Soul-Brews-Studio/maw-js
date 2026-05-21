/**
 * cmdWake coverage without live tmux, ghq, or filesystem side effects beyond
 * temp worktree metadata. This stays in the main test suite so it contributes
 * to `test:coverage`; mocks are gated and delegate to real modules when inactive
 * to avoid cross-file pollution.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let mockActive = false;

const _rSdk = await import("../src/sdk");
const _rGhq = await import("../src/core/ghq");
const _rConfig = await import("../src/config");
const _rWakeResolve = await import("../src/commands/shared/wake-resolve");
const _rWakeSession = await import("../src/commands/shared/wake-session");
const _rWakeMaybeSplit =
  await import("../src/commands/shared/wake-maybe-split");
const _rLifecycle = await import("../src/plugin/lifecycle");
const _rWakeTarget = await import("../src/commands/shared/wake-target");
const _rWakeConcurrency =
  await import("../src/commands/shared/wake-concurrency");
const _rFleetLeaf = await import("../src/core/fleet/leaf");
const _rSnapshot = await import("../src/core/fleet/snapshot");
const _rClaudeSessions = await import("../src/core/fleet/claude-sessions");
const _rShouldAutoWake =
  await import("../src/commands/shared/should-auto-wake");
const _rTeamEnsure = await import("../src/commands/plugins/team/ensure-config");

const realSdk = {
  hostExec: _rSdk.hostExec,
  restoreTabOrder: _rSdk.restoreTabOrder,
  takeSnapshot: _rSdk.takeSnapshot,
  getPaneInfos: _rSdk.getPaneInfos,
  isAgentCommand: _rSdk.isAgentCommand,
  tmux: {
    hasSession: _rSdk.tmux.hasSession.bind(_rSdk.tmux),
    listSessions: _rSdk.tmux.listSessions.bind(_rSdk.tmux),
    listWindows: _rSdk.tmux.listWindows.bind(_rSdk.tmux),
    newSession: _rSdk.tmux.newSession.bind(_rSdk.tmux),
    newWindow: _rSdk.tmux.newWindow.bind(_rSdk.tmux),
    run: _rSdk.tmux.run.bind(_rSdk.tmux),
    sendText: _rSdk.tmux.sendText.bind(_rSdk.tmux),
    selectWindow: _rSdk.tmux.selectWindow.bind(_rSdk.tmux),
    setEnvironment: _rSdk.tmux.setEnvironment.bind(_rSdk.tmux),
  },
};
const realGhq = { ghqFind: _rGhq.ghqFind };
const realConfig = {
  buildCommandInDir: _rConfig.buildCommandInDir,
  cfgTimeout: _rConfig.cfgTimeout,
  loadConfig: _rConfig.loadConfig,
  saveConfig: _rConfig.saveConfig,
};
const realWakeResolve = {
  resolveOracle: _rWakeResolve.resolveOracle,
  findWorktrees: _rWakeResolve.findWorktrees,
  findReusableWorktreeBySlug: _rWakeResolve.findReusableWorktreeBySlug,
  getSessionMap: _rWakeResolve.getSessionMap,
  resolveFleetSession: _rWakeResolve.resolveFleetSession,
  detectSession: _rWakeResolve.detectSession,
  setSessionEnv: _rWakeResolve.setSessionEnv,
  sanitizeBranchName: _rWakeResolve.sanitizeBranchName,
};
const realWakeSession = {
  attachToSession: _rWakeSession.attachToSession,
  ensureSessionRunning: _rWakeSession.ensureSessionRunning,
  createWorktree: _rWakeSession.createWorktree,
};
const realWakeMaybeSplit = {
  maybeSplit: _rWakeMaybeSplit.maybeSplit,
  maybeOpenWindow: _rWakeMaybeSplit.maybeOpenWindow,
};
const realLifecycle = {
  runWakeLifecycleHooks: _rLifecycle.runWakeLifecycleHooks,
};
const realWakeTarget = {
  parseWakeTarget: _rWakeTarget.parseWakeTarget,
  ensureCloned: _rWakeTarget.ensureCloned,
};
const realWakeConcurrency = {
  assertAgentCapacity: _rWakeConcurrency.assertAgentCapacity,
};
const realFleetLeaf = { writeSignal: _rFleetLeaf.writeSignal };
const realSnapshot = {
  latestSnapshot: _rSnapshot.latestSnapshot,
  loadSnapshot: _rSnapshot.loadSnapshot,
};
const realClaudeSessions = {
  listClaudeSessions: _rClaudeSessions.listClaudeSessions,
};
const realShouldAutoWake = { shouldAutoWake: _rShouldAutoWake.shouldAutoWake };
const realTeamEnsure = { ensureTeamConfig: _rTeamEnsure.ensureTeamConfig };

type TmuxWindow = {
  index: number;
  name: string;
  active: boolean;
  cwd?: string;
};
type Snapshot = any;

let tempRoot: string;
let repoPath: string;
let repoName: string;
let parentDir: string;
let resolvedOracle: { repoPath: string; repoName: string; parentDir: string };
let parseWakeTargetReturn: any;
let ghqFindReturn: string | null;
let worktrees: Array<{ name: string; path: string }>;
let sessions: Array<{ name: string }>;
let sessionMap: Record<string, string>;
let fleetSession: string | null;
let detectSessionReturn: string | null;
let shouldWakeDecision: { wake: boolean; reason: string };
let snapshotReturn: Snapshot | null;
let claudeSessions: Array<{
  sessionId: string;
  projectPath: string;
  repo: string | null;
  worktree: { name: string; branch: string } | null;
  pid: number | null;
  ppid: number | null;
  parentChain: string[];
  tmuxTarget: string | null;
  triggeredFrom: "maw-wake" | "tmux" | "desktop" | "cron" | "unknown";
  status: "active" | "idle" | "ended";
  lastActivityAt: string;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  messageCount: number;
  sizeBytes: number;
}>;
let config: any;
let ensureTeamConfigReturn: boolean;
let hasSessions: Set<string>;
let newSessionVisibleToHasSession: boolean;
let windowsBySession: Record<string, TmuxWindow[]>;
let paneCommandDefault: string;
let paneCommands: Record<string, string>;
let liveTileRoles: string[];
let branchName: string;
let ensureSessionRunningReturn: number;
let restoreTabOrderReturn: number;
let listWindowsCalls: string[];
let listWindowsThrowOnCall: number | null;
let throwCurrentSessionProbe: boolean;

let logs: string[];
let hostExecCalls: string[];
let detectSessionCalls: Array<{ oracle: string; urlRepoName?: string }>;
let findWorktreesCalls: Array<{ parentDir: string; repoName: string; taskSlug?: string; scopeStem?: string }>;
let setSessionEnvCalls: string[];
let newSessionCalls: Array<{ name: string; opts: any }>;
let newWindowCalls: Array<{ session: string; name: string; opts: any }>;
let tmuxRunCalls: Array<[string, ...Array<string | number>]>;
let sendTextCalls: Array<{ target: string; text: string }>;
let selectWindowCalls: string[];
let restoreTabOrderCalls: string[];
let takeSnapshotCalls: string[];
let lifecycleCalls: any[];
let assertCapacityCalls: string[];
let saveConfigCalls: any[];
let ensureTeamConfigCalls: string[];
let attachCalls: string[];
let ensureSessionRunningCalls: string[];
let maybeSplitCalls: Array<{ target: string; opts: any }>;
let maybeOpenWindowCalls: Array<{ target: string; opts: any }>;
let writeSignalCalls: Array<{ root: string; child: string; signal: any }>;
let ensureClonedCalls: string[];
let createdWorktrees: Array<{
  repoPath: string;
  parentDir: string;
  repoName: string;
  oracle: string;
  name: string;
  deps?: any;
}>;

function sanitizeForTest(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._\-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+/, "")
    .replace(/(?<![-.])[-.]+$/, "")
    .slice(0, 50);
}

function addWindow(session: string, name: string, opts: any = {}): void {
  const list = windowsBySession[session] ?? (windowsBySession[session] = []);
  if (!list.some((w) => w.name === name)) {
    list.push({
      index: list.length,
      name,
      active: list.length === 0,
      cwd: opts.cwd,
    });
  }
}

function makeSnapshot(sessionName = "54-mawjs"): any {
  return {
    timestamp: "2026-05-16T11:00:00.000Z",
    trigger: "wake",
    node: "m5",
    sessions: [
      {
        name: sessionName,
        windows: [
          { name: "mawjs-oracle" },
          { name: "mawjs-feature" },
          { name: "notes" },
        ],
      },
    ],
  };
}

async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const origLog = console.log;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = origLog;
  }
}

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ..._rSdk,
  hostExec: async (cmd: string) => {
    if (!mockActive) return realSdk.hostExec(cmd);
    hostExecCalls.push(cmd);
    if (cmd.includes("display-message") && cmd.includes("#{session_name}") && !cmd.includes("window_name")) {
      if (throwCurrentSessionProbe) throw new Error("no caller session");
      return "54-mawjs\n";
    }
    if (cmd.includes("list-panes")) return liveTileRoles.join("\n");
    if (cmd.includes("branch --show-current")) return `${branchName}\n`;
    return "";
  },
  restoreTabOrder: async (session: string) => {
    if (!mockActive) return realSdk.restoreTabOrder(session);
    restoreTabOrderCalls.push(session);
    return restoreTabOrderReturn;
  },
  takeSnapshot: async (trigger: string) => {
    if (!mockActive) return realSdk.takeSnapshot(trigger);
    takeSnapshotCalls.push(trigger);
    return join(tempRoot, `${trigger}.json`);
  },
  getPaneInfos: async (targets: string[]) => {
    if (!mockActive) return realSdk.getPaneInfos(targets);
    return Object.fromEntries(
      targets.map((target) => [
        target,
        { command: paneCommands[target] ?? paneCommandDefault, cwd: repoPath },
      ]),
    );
  },
  isAgentCommand: (cmd: string | null | undefined) =>
    mockActive
      ? ["claude", "codex", "node"].includes((cmd ?? "").trim())
      : realSdk.isAgentCommand(cmd),
  tmux: {
    ..._rSdk.tmux,
    hasSession: async (name: string) =>
      mockActive ? hasSessions.has(name) : realSdk.tmux.hasSession(name),
    listSessions: async () =>
      mockActive ? sessions : realSdk.tmux.listSessions(),
    listWindows: async (session: string) =>
      mockActive
        ? (() => {
            listWindowsCalls.push(session);
            if (listWindowsThrowOnCall === listWindowsCalls.length) throw new Error("tmux busy");
            return [...(windowsBySession[session] ?? [])];
          })()
        : realSdk.tmux.listWindows(session),
    newSession: async (name: string, opts: any = {}) => {
      if (!mockActive) return realSdk.tmux.newSession(name, opts);
      newSessionCalls.push({ name, opts });
      if (newSessionVisibleToHasSession) hasSessions.add(name);
      if (!sessions.some((s) => s.name === name)) sessions.push({ name });
      if (opts.window) addWindow(name, opts.window, { cwd: opts.cwd });
    },
    newWindow: async (session: string, name: string, opts: any = {}) => {
      if (!mockActive) return realSdk.tmux.newWindow(session, name, opts);
      newWindowCalls.push({ session, name, opts });
      addWindow(session, name, opts);
    },
    run: async (subcommand: string, ...args: Array<string | number>) => {
      if (!mockActive) return realSdk.tmux.run(subcommand, ...args);
      tmuxRunCalls.push([subcommand, ...args]);
      return "";
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

mock.module(join(import.meta.dir, "../src/core/ghq"), () => ({
  ..._rGhq,
  ghqFind: async (...args: Parameters<typeof _rGhq.ghqFind>) =>
    mockActive ? ghqFindReturn : realGhq.ghqFind(...args),
}));

mock.module(join(import.meta.dir, "../src/config"), () => ({
  ..._rConfig,
  buildCommandInDir: (windowName: string, cwd: string, engine?: string) => {
    if (!mockActive)
      return realConfig.buildCommandInDir(windowName, cwd, engine);
    return `cd ${cwd} && ${engine ?? "codex"} --agent ${windowName}`;
  },
  cfgTimeout: (key: Parameters<typeof _rConfig.cfgTimeout>[0]) =>
    mockActive ? 0 : realConfig.cfgTimeout(key),
  loadConfig: () => (mockActive ? config : realConfig.loadConfig()),
  saveConfig: (patch: any) => {
    if (!mockActive) return realConfig.saveConfig(patch);
    saveConfigCalls.push(patch);
    config = { ...config, ...patch };
  },
}));

mock.module(
  join(import.meta.dir, "../src/commands/shared/wake-resolve"),
  () => ({
    ..._rWakeResolve,
    resolveOracle: async (
      ...args: Parameters<typeof _rWakeResolve.resolveOracle>
    ) => (mockActive ? resolvedOracle : realWakeResolve.resolveOracle(...args)),
    findWorktrees: async (parentDirArg: string, repoNameArg: string, taskSlug?: string, scopeStem?: string) => {
      if (!mockActive)
        return realWakeResolve.findWorktrees(parentDirArg, repoNameArg, taskSlug, scopeStem);
      findWorktreesCalls.push({
        parentDir: parentDirArg,
        repoName: repoNameArg,
        taskSlug,
        scopeStem,
      });
      return worktrees;
    },
    findReusableWorktreeBySlug: (parentDirArg: string, slug: string, scopeStem?: string) =>
      mockActive
        ? null
        : realWakeResolve.findReusableWorktreeBySlug(parentDirArg, slug, scopeStem),
    getSessionMap: () =>
      mockActive ? sessionMap : realWakeResolve.getSessionMap(),
    resolveFleetSession: (oracle: string) =>
      mockActive ? fleetSession : realWakeResolve.resolveFleetSession(oracle),
    detectSession: async (oracle: string, urlRepoName?: string) => {
      if (!mockActive)
        return realWakeResolve.detectSession(oracle, urlRepoName);
      detectSessionCalls.push({ oracle, urlRepoName });
      return detectSessionReturn;
    },
    setSessionEnv: async (session: string) => {
      if (!mockActive) return realWakeResolve.setSessionEnv(session);
      setSessionEnvCalls.push(session);
    },
    sanitizeBranchName: (value: string) =>
      mockActive
        ? sanitizeForTest(value)
        : realWakeResolve.sanitizeBranchName(value),
  }),
);

mock.module(
  join(import.meta.dir, "../src/commands/shared/wake-session"),
  () => ({
    ..._rWakeSession,
    attachToSession: async (
      ...args: Parameters<typeof _rWakeSession.attachToSession>
    ) => {
      if (!mockActive) return realWakeSession.attachToSession(...args);
      const [session] = args;
      attachCalls.push(session);
    },
    ensureSessionRunning: async (
      ...args: Parameters<typeof _rWakeSession.ensureSessionRunning>
    ) => {
      if (!mockActive) return realWakeSession.ensureSessionRunning(...args);
      const [session] = args;
      ensureSessionRunningCalls.push(session);
      return ensureSessionRunningReturn;
    },
    createWorktree: async (
      repoPathArg: string,
      parentDirArg: string,
      repoNameArg: string,
      oracleArg: string,
      name: string,
      existingWorktrees: { name: string; path: string }[] = [],
      deps?: Parameters<typeof _rWakeSession.createWorktree>[6],
    ) => {
      if (!mockActive)
        return realWakeSession.createWorktree(
          repoPathArg,
          parentDirArg,
          repoNameArg,
          oracleArg,
          name,
          existingWorktrees,
          deps,
        );
      createdWorktrees.push({
        repoPath: repoPathArg,
        parentDir: parentDirArg,
        repoName: repoNameArg,
        oracle: oracleArg,
        name,
        deps,
      });
      const wtPath = join(parentDirArg, `${repoNameArg}.wt-${name}`);
      mkdirSync(wtPath, { recursive: true });
      return { wtPath, windowName: `${oracleArg}-${name}` };
    },
  }),
);

mock.module(
  join(import.meta.dir, "../src/commands/shared/wake-maybe-split"),
  () => ({
    ..._rWakeMaybeSplit,
    maybeSplit: async (target: string, opts: any) => {
      if (!mockActive) return realWakeMaybeSplit.maybeSplit(target, opts);
      maybeSplitCalls.push({ target, opts });
    },
    maybeOpenWindow: async (target: string, opts: any) => {
      if (!mockActive) return realWakeMaybeSplit.maybeOpenWindow(target, opts);
      maybeOpenWindowCalls.push({ target, opts });
    },
  }),
);

mock.module(join(import.meta.dir, "../src/plugin/lifecycle"), () => ({
  ..._rLifecycle,
  runWakeLifecycleHooks: async (
    ...args: Parameters<typeof _rLifecycle.runWakeLifecycleHooks>
  ) => {
    if (!mockActive) return realLifecycle.runWakeLifecycleHooks(...args);
    const payload = args[0];
    lifecycleCalls.push(payload);
    return { phase: "wake", ran: 0, skipped: 0, failed: 0 };
  },
}));

mock.module(
  join(import.meta.dir, "../src/commands/shared/wake-target"),
  () => ({
    ..._rWakeTarget,
    parseWakeTarget: (target: string) =>
      mockActive
        ? parseWakeTargetReturn
        : realWakeTarget.parseWakeTarget(target),
    ensureCloned: async (slug: string) => {
      if (!mockActive) return realWakeTarget.ensureCloned(slug);
      ensureClonedCalls.push(slug);
    },
  }),
);

mock.module(
  join(import.meta.dir, "../src/commands/shared/wake-concurrency"),
  () => ({
    ..._rWakeConcurrency,
    assertAgentCapacity: async (oracle: string) => {
      if (!mockActive) return realWakeConcurrency.assertAgentCapacity(oracle);
      assertCapacityCalls.push(oracle);
    },
  }),
);

mock.module(join(import.meta.dir, "../src/core/fleet/leaf"), () => ({
  ..._rFleetLeaf,
  writeSignal: (root: string, child: string, signal: any) => {
    if (!mockActive) return realFleetLeaf.writeSignal(root, child, signal);
    writeSignalCalls.push({ root, child, signal });
    return join(root, "ψ", "memory", "signals", `${child}.json`);
  },
}));

mock.module(join(import.meta.dir, "../src/core/fleet/snapshot"), () => ({
  ..._rSnapshot,
  latestSnapshot: () =>
    mockActive ? snapshotReturn : realSnapshot.latestSnapshot(),
  loadSnapshot: (id: string) =>
    mockActive ? snapshotReturn : realSnapshot.loadSnapshot(id),
}));

mock.module(join(import.meta.dir, "../src/core/fleet/claude-sessions"), () => ({
  ..._rClaudeSessions,
  listClaudeSessions: () =>
    mockActive ? Promise.resolve(claudeSessions as any) : realClaudeSessions.listClaudeSessions(),
}));

mock.module(
  join(import.meta.dir, "../src/commands/shared/should-auto-wake"),
  () => ({
    ..._rShouldAutoWake,
    shouldAutoWake: (
      ...args: Parameters<typeof _rShouldAutoWake.shouldAutoWake>
    ) =>
      mockActive
        ? shouldWakeDecision
        : realShouldAutoWake.shouldAutoWake(...args),
  }),
);

mock.module(
  join(import.meta.dir, "../src/commands/plugins/team/ensure-config"),
  () => ({
    ..._rTeamEnsure,
    ensureTeamConfig: (name: string) => {
      if (!mockActive) return realTeamEnsure.ensureTeamConfig(name);
      ensureTeamConfigCalls.push(name);
      return ensureTeamConfigReturn;
    },
  }),
);

const { cmdWake, _wtPicker, promptAmbiguousBringPick } = await import("../src/commands/shared/wake-cmd");
const originalWtPickerIsStdoutTTY = _wtPicker.isStdoutTTY;
const originalWtPickerReadChoice = _wtPicker.readChoice;

beforeEach(() => {
  mockActive = true;
  tempRoot = mkdtempSync(join(tmpdir(), "maw-wake-cmd-coverage-"));
  repoName = "mawjs-oracle";
  parentDir = tempRoot;
  repoPath = join(parentDir, repoName);
  mkdirSync(repoPath, { recursive: true });
  resolvedOracle = { repoPath, repoName, parentDir };
  parseWakeTargetReturn = null;
  ghqFindReturn = null;
  worktrees = [];
  sessions = [{ name: "54-mawjs" }];
  sessionMap = {};
  fleetSession = null;
  detectSessionReturn = "54-mawjs";
  shouldWakeDecision = { wake: false, reason: "already-live" };
  snapshotReturn = null;
  claudeSessions = [];
  config = { node: "m5", agents: {} };
  ensureTeamConfigReturn = false;
  hasSessions = new Set(["54-mawjs"]);
  newSessionVisibleToHasSession = true;
  windowsBySession = {
    "54-mawjs": [
      { index: 0, name: "mawjs-oracle", active: true, cwd: repoPath },
    ],
  };
  paneCommandDefault = "codex";
  paneCommands = {};
  liveTileRoles = [];
  branchName = "main";
  ensureSessionRunningReturn = 0;
  restoreTabOrderReturn = 0;
  listWindowsCalls = [];
  listWindowsThrowOnCall = null;
  throwCurrentSessionProbe = false;

  logs = [];
  hostExecCalls = [];
  detectSessionCalls = [];
  findWorktreesCalls = [];
  setSessionEnvCalls = [];
  newSessionCalls = [];
  newWindowCalls = [];
  tmuxRunCalls = [];
  sendTextCalls = [];
  selectWindowCalls = [];
  restoreTabOrderCalls = [];
  takeSnapshotCalls = [];
  lifecycleCalls = [];
  assertCapacityCalls = [];
  saveConfigCalls = [];
  ensureTeamConfigCalls = [];
  attachCalls = [];
  ensureSessionRunningCalls = [];
  maybeSplitCalls = [];
  maybeOpenWindowCalls = [];
  writeSignalCalls = [];
  ensureClonedCalls = [];
  createdWorktrees = [];
});

afterEach(() => {
  mockActive = false;
  _wtPicker.isStdoutTTY = originalWtPickerIsStdoutTTY;
  _wtPicker.readChoice = originalWtPickerReadChoice;
  if (tempRoot && existsSync(tempRoot))
    rmSync(tempRoot, { recursive: true, force: true });
});

describe("cmdWake main-suite coverage", () => {
  test("#1816 bring picker handles headless, empty, quit, invalid, and success choices", () => {
    const candidate = { name: "mawjs-features", target: "54-mawjs:mawjs-features", detail: "tmux window" };

    _wtPicker.isStdoutTTY = () => false;
    expect(promptAmbiguousBringPick("features", [candidate])).toBeNull();

    _wtPicker.isStdoutTTY = () => true;
    expect(promptAmbiguousBringPick("features", [])).toBeNull();

    _wtPicker.readChoice = () => "q";
    expect(promptAmbiguousBringPick("features", [candidate])).toBeNull();

    _wtPicker.readChoice = () => "quit";
    expect(promptAmbiguousBringPick("features", [candidate])).toBeNull();

    _wtPicker.readChoice = () => "abc";
    expect(promptAmbiguousBringPick("features", [candidate])).toBeNull();

    _wtPicker.readChoice = () => "2";
    expect(promptAmbiguousBringPick("features", [candidate])).toBeNull();

    _wtPicker.readChoice = () => "1";
    expect(promptAmbiguousBringPick("features", [candidate])).toEqual(candidate);
  });

  test("lists worktrees without detecting or mutating tmux", async () => {
    worktrees = [
      { name: "1-alpha", path: join(parentDir, `${repoName}.wt-1-alpha`) },
      { name: "2-beta", path: join(parentDir, `${repoName}.wt-2-beta`) },
    ];
    claudeSessions = [
      {
        sessionId: "alpha-new",
        projectPath: worktrees[0]!.path,
        repo: null,
        worktree: null,
        pid: null,
        ppid: null,
        parentChain: [],
        tmuxTarget: null,
        triggeredFrom: "maw-wake",
        status: "idle",
        lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastUserMessage: null,
        lastAssistantMessage: null,
        messageCount: 3,
        sizeBytes: 300,
      },
      {
        sessionId: "alpha-old",
        projectPath: worktrees[0]!.path,
        repo: null,
        worktree: null,
        pid: null,
        ppid: null,
        parentChain: [],
        tmuxTarget: null,
        triggeredFrom: "maw-wake",
        status: "ended",
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        lastUserMessage: null,
        lastAssistantMessage: null,
        messageCount: 7,
        sizeBytes: 700,
      },
    ];

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", { listWt: true }),
    );
    const rendered = logs.join("\n");

    expect(result).toBe("mawjs:list");
    expect(rendered).toContain("Worktrees for mawjs");
    expect(rendered).toContain("1-alpha");
    expect(rendered).toContain("idle · 10 msgs · last");
    expect(rendered).toContain("2-beta");
    expect(detectSessionCalls).toHaveLength(0);
    expect(newSessionCalls).toHaveLength(0);
    expect(newWindowCalls).toHaveLength(0);
    expect(sendTextCalls).toHaveLength(0);
    expect(findWorktreesCalls).toEqual([{ parentDir, repoName }]);
  });

  test("dry-runs missing sessions with numeric fleet session planning and rehydrate preview", async () => {
    detectSessionReturn = null;
    shouldWakeDecision = { wake: true, reason: "missing" };
    sessions = [{ name: "02-maw" }, { name: "09-volt" }];
    worktrees = [
      { name: "1-alpha", path: join(parentDir, `${repoName}.wt-1-alpha`) },
      { name: "2-beta", path: join(parentDir, `${repoName}.wt-2-beta`) },
    ];

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", { dryRun: true }),
    );
    const rendered = logs.join("\n");

    expect(result).toBe("mawjs:dry-run");
    expect(rendered).toContain("would create session");
    expect(rendered).toContain("10-mawjs");
    expect(rendered).toContain("would respawn: mawjs-alpha");
    expect(rendered).toContain("would respawn: mawjs-beta");
    expect(newSessionCalls).toHaveLength(0);
    expect(newWindowCalls).toHaveLength(0);
    expect(sendTextCalls).toHaveLength(0);
  });

  test("#1816 bring resolves an exact live tmux window before fuzzy oracle lookup", async () => {
    addWindow("54-mawjs", "mawjs-features");

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs-features", {
        bringAlias: true,
        split: true,
        session: "54-mawjs",
        splitTarget: "54-mawjs:maw-js-1816",
      }),
    );

    expect(result).toBe("54-mawjs:mawjs-features");
    expect(logs.join("\n")).toContain("live tmux window: 54-mawjs:mawjs-features");
    expect(detectSessionCalls).toEqual([]);
    expect(findWorktreesCalls).toEqual([]);
    expect(newWindowCalls).toEqual([]);
    expect(maybeSplitCalls).toEqual([
      {
        target: "54-mawjs:mawjs-features",
        opts: expect.objectContaining({
          bringAlias: true,
          split: true,
          session: "54-mawjs",
          splitTarget: "54-mawjs:maw-js-1816",
        }),
      },
    ]);
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });

  test("#1816 bring dry-run resolves exact windows from --to session:window", async () => {
    addWindow("54-mawjs", "mawjs-features");

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs-features", {
        bringAlias: true,
        split: true,
        splitTarget: "54-mawjs:maw-js-1816",
        dryRun: true,
      }),
    );

    expect(result).toBe("54-mawjs:mawjs-features");
    expect(logs.join("\n")).toContain("dry-run — no tmux sessions/windows will be changed");
    expect(detectSessionCalls).toEqual([]);
    expect(maybeSplitCalls).toEqual([]);
    expect(takeSnapshotCalls).toEqual([]);
  });

  test("#1824 bring --to window-name resolves from non-tmux shells", async () => {
    const originalPane = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    addWindow("54-mawjs", "mawjs-features");
    try {
      const { result, logs } = await captureLogs(() =>
        cmdWake("mawjs-features", {
          bringAlias: true,
          split: true,
          session: "mawjs-oracle",
        }),
      );

      expect(result).toBe("54-mawjs:mawjs-features");
      expect(logs.join("\n")).toContain("live tmux window: 54-mawjs:mawjs-features");
      expect(maybeSplitCalls).toEqual([
        {
          target: "54-mawjs:mawjs-features",
          opts: expect.objectContaining({
            bringAlias: true,
            split: true,
            session: "54-mawjs",
            splitTarget: "54-mawjs:mawjs-oracle",
            resolvedBringDestinationWindow: expect.objectContaining({
              target: "54-mawjs:mawjs-oracle",
            }),
          }),
        },
      ]);
    } finally {
      if (originalPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = originalPane;
    }
    expect(detectSessionCalls).toEqual([]);
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });

  test("#1824 bring --to window-name suggests session:window for fuzzy source names", async () => {
    const originalPane = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    addWindow("54-mawjs", "mawjs-features");
    try {
      await expect(captureLogs(() =>
        cmdWake("features", {
          bringAlias: true,
          split: true,
          session: "mawjs-oracle",
        }),
      )).rejects.toThrow("Try: maw bring mawjs-features --to 54-mawjs:mawjs-oracle");
    } finally {
      if (originalPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = originalPane;
    }
    expect(detectSessionCalls).toEqual([]);
    expect(maybeSplitCalls).toEqual([]);
    expect(takeSnapshotCalls).toEqual([]);
  });

  test("#1824 bring --to window-name reports ambiguous destination windows", async () => {
    sessions.push({ name: "55-mawjs" });
    hasSessions.add("55-mawjs");
    addWindow("54-mawjs", "mawjs-features");
    addWindow("55-mawjs", "mawjs-oracle");

    await expect(captureLogs(() =>
      cmdWake("mawjs-features", {
        bringAlias: true,
        split: true,
        session: "mawjs-oracle",
      }),
    )).rejects.toThrow("matches multiple live tmux windows");

    await expect(captureLogs(() =>
      cmdWake("mawjs-features", {
        bringAlias: true,
        split: true,
        session: "mawjs-oracle",
      }),
    )).rejects.toThrow("54-mawjs:mawjs-oracle");
  });

  test("#1816 bring can resolve exact windows from the caller tmux session", async () => {
    const originalPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%42";
    addWindow("54-mawjs", "mawjs-features");
    try {
      const { result } = await captureLogs(() =>
        cmdWake("mawjs-features", { bringAlias: true, split: true }),
      );
      expect(result).toBe("54-mawjs:mawjs-features");
    } finally {
      if (originalPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = originalPane;
    }
    expect(hostExecCalls).toContain("tmux display-message -p -t '%42' '#{session_name}'");
  });

  test("#1816 bring --pick can choose a fuzzy live tmux window before oracle fallback", async () => {
    addWindow("54-mawjs", "mawjs-features");
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1";

    const { result, logs } = await captureLogs(() =>
      cmdWake("features", {
        bringAlias: true,
        split: true,
        pick: true,
        session: "54-mawjs",
      }),
    );

    expect(result).toBe("54-mawjs:mawjs-features");
    expect(logs.join("\n")).toContain("'features' is ambiguous — bring which?");
    expect(logs.join("\n")).toContain("mawjs-features");
    expect(detectSessionCalls).toEqual([]);
    expect(findWorktreesCalls).toEqual([]);
    expect(newWindowCalls).toEqual([]);
    expect(maybeSplitCalls).toEqual([
      {
        target: "54-mawjs:mawjs-features",
        opts: expect.objectContaining({
          bringAlias: true,
          split: true,
          pick: true,
          session: "54-mawjs",
        }),
      },
    ]);
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });

  test("#1816 bring --pick fails loudly for fuzzy live windows when headless", async () => {
    addWindow("54-mawjs", "mawjs-features");
    _wtPicker.isStdoutTTY = () => false;

    await expect(captureLogs(() =>
      cmdWake("features", {
        bringAlias: true,
        split: true,
        pick: true,
        session: "54-mawjs",
      }),
    )).rejects.toThrow("--pick requires an interactive bring selection for 'features'");

    expect(detectSessionCalls).toEqual([]);
    expect(maybeSplitCalls).toEqual([]);
    expect(takeSnapshotCalls).toEqual([]);
  });

  test("#1816 bring --pick can disambiguate multiple fuzzy live tmux windows", async () => {
    addWindow("54-mawjs", "mawjs-alpha", { cwd: join(tempRoot, "plain-workspace") });
    addWindow("54-mawjs", "other-alpha");
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "2";

    const { result, logs } = await captureLogs(() =>
      cmdWake("alpha", {
        bringAlias: true,
        split: true,
        pick: true,
        session: "54-mawjs",
      }),
    );

    expect(result).toBe("54-mawjs:other-alpha");
    expect(logs.join("\n")).toContain("'alpha' is ambiguous — bring which?");
    expect(logs.join("\n")).toContain("mawjs-alpha");
    expect(logs.join("\n")).toContain("other-alpha");
    expect(maybeSplitCalls).toEqual([
      {
        target: "54-mawjs:other-alpha",
        opts: expect.objectContaining({ bringAlias: true, split: true, pick: true }),
      },
    ]);
  });

  test("#1816 bring --pick includes oracle and worktree names from live window cwd", async () => {
    const buddyRepo = join(parentDir, "buddy-oracle");
    const featureWorktree = join(parentDir, `${repoName}.wt-2-feature-blue`);
    mkdirSync(buddyRepo, { recursive: true });
    mkdirSync(featureWorktree, { recursive: true });
    addWindow("54-mawjs", "operator-console", { cwd: buddyRepo });
    addWindow("54-mawjs", "scratch-pad", { cwd: featureWorktree });
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1";

    const oraclePick = await captureLogs(() =>
      cmdWake("buddy", {
        bringAlias: true,
        split: true,
        pick: true,
        session: "54-mawjs",
      }),
    );

    expect(oraclePick.result).toBe("54-mawjs:operator-console");
    expect(oraclePick.logs.join("\n")).toContain("operator-console");
    expect(oraclePick.logs.join("\n")).toContain("oracle buddy");

    maybeSplitCalls = [];
    takeSnapshotCalls = [];

    const worktreePick = await captureLogs(() =>
      cmdWake("feature-blue", {
        bringAlias: true,
        split: true,
        pick: true,
        session: "54-mawjs",
      }),
    );

    expect(worktreePick.result).toBe("54-mawjs:scratch-pad");
    expect(worktreePick.logs.join("\n")).toContain("scratch-pad");
    expect(worktreePick.logs.join("\n")).toContain("oracle mawjs");
    expect(worktreePick.logs.join("\n")).toContain("worktree 2-feature-blue");
    expect(maybeSplitCalls).toEqual([
      {
        target: "54-mawjs:scratch-pad",
        opts: expect.objectContaining({ bringAlias: true, split: true, pick: true }),
      },
    ]);
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });

  test("#1816 bring --pick with no live-window candidates preserves oracle fallback", async () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1";

    const { result } = await captureLogs(() =>
      cmdWake("totally-missing-window", {
        bringAlias: true,
        split: true,
        pick: true,
        session: "54-mawjs",
      }),
    );

    expect(result).toBe("54-mawjs:mawjs");
    expect(detectSessionCalls).toEqual([]);
    expect(maybeSplitCalls).toEqual([
      {
        target: "54-mawjs:mawjs",
        opts: expect.objectContaining({ bringAlias: true, split: true, pick: true }),
      },
    ]);
  });

  test("#1816 bring falls back to legacy oracle resolution when caller session cannot be read", async () => {
    const originalPane = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%42";
    throwCurrentSessionProbe = true;
    try {
      const { result } = await captureLogs(() =>
        cmdWake("mawjs-features", { bringAlias: true, split: true }),
      );
      expect(result).toBe("54-mawjs:mawjs-oracle");
    } finally {
      if (originalPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = originalPane;
    }
    expect(detectSessionCalls).toEqual([{ oracle: "mawjs", urlRepoName: undefined }]);
  });



  test("resolves explicit GitHub targets through the parsed slug path", async () => {
    parseWakeTargetReturn = {
      oracle: "graph",
      slug: "the-oracle-keeps-the-human-human/graph-oracle",
    };
    ghqFindReturn = join(parentDir, "graph-oracle");
    repoName = "graph-oracle";
    repoPath = ghqFindReturn;
    mkdirSync(repoPath, { recursive: true });
    detectSessionReturn = "24-graph";
    hasSessions = new Set(["24-graph"]);
    windowsBySession = {
      "24-graph": [{ index: 0, name: "graph-oracle", active: true, cwd: repoPath }],
    };

    const { result } = await captureLogs(() =>
      cmdWake("https://github.com/the-oracle-keeps-the-human-human/graph-oracle", {}),
    );

    expect(result).toBe("24-graph:graph-oracle");
    expect(ensureClonedCalls).toEqual(["the-oracle-keeps-the-human-human/graph-oracle"]);
    expect(detectSessionCalls).toEqual([{ oracle: "graph", urlRepoName: "graph-oracle" }]);
    expect(findWorktreesCalls).toEqual([{ parentDir, repoName: "graph-oracle", taskSlug: undefined, scopeStem: undefined }]);
  });

  test("incubates missing repos with a github.com prefix and defaults the worktree slug", async () => {
    repoName = "new-tool";
    repoPath = join(parentDir, repoName);
    ghqFindReturn = repoPath;
    mkdirSync(repoPath, { recursive: true });
    resolvedOracle = { repoPath, repoName, parentDir };
    sessions = [{ name: "12-seed" }];
    hasSessions = new Set(["12-seed"]);
    detectSessionReturn = "12-seed";
    windowsBySession = {
      "12-seed": [{ index: 0, name: "seed-oracle", active: true, cwd: repoPath }],
    };

    const { result } = await captureLogs(() =>
      cmdWake("seed", { incubate: "Soul-Brews-Studio/new-tool" }),
    );

    expect(result).toBe("12-seed:seed-newtool");
    expect(hostExecCalls).toContain("ghq get -u github.com/Soul-Brews-Studio/new-tool");
    expect(createdWorktrees).toEqual([
      { repoPath, parentDir, repoName, oracle: "seed", name: "newtool", deps: { fresh: false, named: false } },
    ]);
  });

  test("surfaces guarded wake option errors before tmux mutation", async () => {
    await expect(captureLogs(() => cmdWake("mawjs", { bud: true }))).rejects.toThrow("--bud requires --task <slug> or --wt <slug>");
    await expect(captureLogs(() => cmdWake("mawjs", { signalOnBirth: true }))).rejects.toThrow("--signal-on-birth requires --bud");
    await expect(captureLogs(() => cmdWake("mawjs", { session: "bad/session" }))).rejects.toThrow("invalid target session 'bad/session'");
    sessions = [];
    hasSessions = new Set();
    await expect(captureLogs(() => cmdWake("mawjs", { session: "project" }))).rejects.toThrow("target session 'project' not found");
    expect(newSessionCalls).toEqual([]);
    expect(newWindowCalls).toEqual([]);
  });

  test("surfaces snapshot selection failures", async () => {
    snapshotReturn = null;
    await expect(captureLogs(() => cmdWake("mawjs", { fromSnapshot: true, snapshotId: "missing" }))).rejects.toThrow("snapshot not found: missing");

    snapshotReturn = makeSnapshot("71-other");
    await expect(captureLogs(() => cmdWake("mawjs", { fromSnapshot: true }))).rejects.toThrow("has no session for mawjs");
  });

  test("dry-runs foreign sessions and wake-bud previews without rehydrating", async () => {
    sessions = [{ name: "project" }];
    hasSessions = new Set(["project"]);
    windowsBySession = { project: [] };

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", { session: "project", dryRun: true, task: "Fix 42", bud: true, signalOnBirth: true }),
    );

    expect(result).toBe("project:mawjs");
    expect(logs.join("\n")).toContain("would wake window 'mawjs' in workspace session 'project'");
    expect(logs.join("\n")).toContain("would stamp wake-bud lineage");
    expect(logs.join("\n")).toContain("would drop wake-bud birth signal");
    expect(findWorktreesCalls).toEqual([]);
    expect(newWindowCalls).toEqual([]);
  });

  test("wakes into an explicit foreign workspace session without home-session lookup side effects", async () => {
    repoName = "volt-oracle";
    repoPath = join(parentDir, repoName);
    mkdirSync(repoPath, { recursive: true });
    resolvedOracle = { repoPath, repoName, parentDir };
    sessions = [{ name: "project" }];
    hasSessions = new Set(["project"]);
    windowsBySession = { project: [{ index: 0, name: "lead", active: true }] };
    detectSessionReturn = "51-volt";

    const { result } = await captureLogs(() =>
      cmdWake("volt", { repoPath, session: "project", noRehydrate: true }),
    );

    expect(result).toBe("project:volt");
    expect(detectSessionCalls).toHaveLength(0);
    expect(restoreTabOrderCalls).toHaveLength(0);
    expect(findWorktreesCalls).toHaveLength(0);
    expect(setSessionEnvCalls).toEqual(["project"]);
    expect(newWindowCalls).toEqual([
      { session: "project", name: "volt", opts: { cwd: repoPath } },
    ]);
    expect(sendTextCalls).toEqual([
      { target: "project:volt", text: `cd ${repoPath} && codex --agent volt` },
    ]);
  });

  test("creates a fresh session, registers config, auto-creates team metadata, and rehydrates worktrees", async () => {
    detectSessionReturn = null;
    shouldWakeDecision = { wake: true, reason: "missing" };
    sessions = [{ name: "09-old" }];
    hasSessions = new Set(["09-old"]);
    windowsBySession = {};
    worktrees = [
      { name: "1-alpha", path: join(parentDir, `${repoName}.wt-1-alpha`) },
    ];
    ensureTeamConfigReturn = true;
    restoreTabOrderReturn = 1;

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", { engine: "codex" }),
    );

    expect(result).toBe("10-mawjs:mawjs-oracle");
    expect(assertCapacityCalls).toEqual(["mawjs"]);
    expect(newSessionCalls).toEqual([
      { name: "10-mawjs", opts: { window: "mawjs-oracle", cwd: repoPath } },
    ]);
    expect(setSessionEnvCalls).toEqual(["10-mawjs"]);
    expect(sendTextCalls).toContainEqual({
      target: "10-mawjs:mawjs-oracle",
      text: `cd ${repoPath} && codex --agent mawjs-oracle`,
    });
    expect(newWindowCalls).toContainEqual({
      session: "10-mawjs",
      name: "mawjs-alpha",
      opts: { cwd: worktrees[0]!.path },
    });
    expect(saveConfigCalls).toEqual([{ agents: { mawjs: "m5" } }]);
    expect(ensureTeamConfigCalls).toEqual(["mawjs"]);
    expect(lifecycleCalls).toContainEqual({
      oracle: "mawjs",
      session: "10-mawjs",
      repoPath,
      repoName,
    });
    expect(restoreTabOrderCalls).toEqual(["10-mawjs"]);
    expect(logs.join("\n")).toContain("auto-created");
  });

  test("creates and attaches a fresh session without trusting the external readiness probe", async () => {
    detectSessionReturn = null;
    shouldWakeDecision = { wake: true, reason: "missing" };
    sessions = [{ name: "62-old" }];
    hasSessions = new Set(["62-old"]);
    newSessionVisibleToHasSession = false;
    windowsBySession = {};

    const { result } = await captureLogs(() =>
      cmdWake("mawjs", { attach: true, engine: "codex" }),
    );

    expect(result).toBe("63-mawjs:mawjs-oracle");
    expect(newSessionCalls).toEqual([
      { name: "63-mawjs", opts: { window: "mawjs-oracle", cwd: repoPath } },
    ]);
    expect(setSessionEnvCalls).toEqual(["63-mawjs"]);
    expect(sendTextCalls).toContainEqual({
      target: "63-mawjs:mawjs-oracle",
      text: `cd ${repoPath} && codex --agent mawjs-oracle`,
    });
    expect(attachCalls).toEqual(["63-mawjs"]);
  });

  test("restores requested snapshot windows, rehydrates missing worktrees, and relaunches a dead existing agent", async () => {
    snapshotReturn = makeSnapshot("54-mawjs");
    worktrees = [
      { name: "1-feature", path: join(parentDir, `${repoName}.wt-1-feature`) },
      { name: "2-extra", path: join(parentDir, `${repoName}.wt-2-extra`) },
    ];
    windowsBySession = {
      "54-mawjs": [
        { index: 0, name: "mawjs-oracle", active: true, cwd: repoPath },
      ],
    };
    paneCommandDefault = "zsh";
    ensureSessionRunningReturn = 2;
    restoreTabOrderReturn = 1;

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", { fromSnapshot: true, snapshotId: "snap-1" }),
    );

    expect(result).toBe("54-mawjs:mawjs-oracle");
    expect(newWindowCalls).toEqual([
      {
        session: "54-mawjs",
        name: "mawjs-feature",
        opts: { cwd: worktrees[0]!.path },
      },
      { session: "54-mawjs", name: "notes", opts: { cwd: repoPath } },
      {
        session: "54-mawjs",
        name: "mawjs-extra",
        opts: { cwd: worktrees[1]!.path },
      },
    ]);
    expect(ensureSessionRunningCalls).toEqual(["54-mawjs"]);
    expect(sendTextCalls).toContainEqual({
      target: "54-mawjs:mawjs-oracle",
      text: `cd ${repoPath} && codex --agent mawjs-oracle`,
    });
    expect(restoreTabOrderCalls).toEqual(["54-mawjs"]);
    expect(takeSnapshotCalls).toEqual(["wake"]);
    const rendered = logs.join("\n");
    expect(rendered).toContain("snapshot restore: 2 windows");
    expect(rendered).toContain("2 window(s) retried");
    expect(rendered).toContain("agent dead, re-launching");
  });

  test("reuses the first window listing so a later tmux list failure cannot create a duplicate", async () => {
    listWindowsThrowOnCall = 2;

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", {}),
    );

    expect(result).toBe("54-mawjs:mawjs-oracle");
    expect(listWindowsCalls).toEqual(["54-mawjs"]);
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
    expect(logs.join("\n")).toContain("'mawjs-oracle' running in 54-mawjs");
  });

  test("respawns an existing running window when an explicit engine is requested", async () => {
    paneCommandDefault = "claude";

    const { result, logs } = await captureLogs(() =>
      cmdWake("mawjs", { engine: "thclaws" }),
    );

    expect(result).toBe("54-mawjs:mawjs-oracle");
    expect(sendTextCalls).toEqual([]);
    expect(tmuxRunCalls).toContainEqual([
      "respawn-pane",
      "-k",
      "-t",
      "54-mawjs:mawjs-oracle",
      `cd ${repoPath} && thclaws --agent mawjs-oracle`,
    ]);
    expect(logs.join("\n")).toContain("switching engine to thclaws");
  });

  test("sends prompts into an existing window without creating duplicates", async () => {
    const { result } = await captureLogs(() =>
      cmdWake("mawjs", { prompt: "quote safe", split: true, window: true }),
    );

    expect(result).toBe("54-mawjs:mawjs-oracle");
    expect(newWindowCalls).toEqual([]);
    expect(selectWindowCalls).toEqual(["54-mawjs:mawjs-oracle"]);
    expect(sendTextCalls).toEqual([
      {
        target: "54-mawjs:mawjs-oracle",
        text: `cd ${repoPath} && codex --agent mawjs-oracle -p 'quote safe'`,
      },
    ]);
    expect(maybeSplitCalls).toEqual([
      { target: "54-mawjs:mawjs-oracle", opts: expect.objectContaining({ split: true, window: true }) },
    ]);
    expect(maybeOpenWindowCalls).toEqual([
      { target: "54-mawjs:mawjs-oracle", opts: expect.objectContaining({ split: true, window: true }) },
    ]);
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });

  test("uses a numeric pre-resolved session without re-detecting the oracle", async () => {
    sessions = [{ name: "03-other" }, { name: "54-mawjs" }];
    hasSessions = new Set(["03-other", "54-mawjs"]);

    const { result } = await captureLogs(() =>
      cmdWake("54-mawjs", { noRehydrate: true }),
    );

    expect(result).toBe("54-mawjs:mawjs-oracle");
    expect(detectSessionCalls).toEqual([]);
    expect(setSessionEnvCalls).toEqual(["54-mawjs"]);
    expect(newSessionCalls).toEqual([]);
    expect(newWindowCalls).toEqual([]);
  });

  test("reuses a cross-repo worktree for --wt when the slug matches (#1775)", async () => {
    repoName = "homelab";
    repoPath = join(parentDir, repoName);
    mkdirSync(repoPath, { recursive: true });
    resolvedOracle = { repoPath, repoName, parentDir };
    sessions = [{ name: "04-homekeeper" }];
    hasSessions = new Set(["04-homekeeper"]);
    detectSessionReturn = "04-homekeeper";
    windowsBySession = {
      "04-homekeeper": [{ index: 0, name: "homekeeper-oracle", active: true, cwd: repoPath }],
    };
    worktrees = [{ name: "2-white", path: join(parentDir, "homekeeper-oracle.wt-2-white") }];

    const { result, logs } = await captureLogs(() => cmdWake("homekeeper", { wt: "white" }));

    expect(result).toBe("04-homekeeper:homekeeper-white");
    expect(findWorktreesCalls).toContainEqual({
      parentDir,
      repoName: "homelab",
      taskSlug: "white",
      scopeStem: "homekeeper-oracle",
    });
    expect(createdWorktrees).toEqual([]);
    expect(newWindowCalls).toContainEqual({
      session: "04-homekeeper",
      name: "homekeeper-white",
      opts: { cwd: join(parentDir, "homekeeper-oracle.wt-2-white") },
    });
    expect(logs.join("\n")).toContain("reusing worktree");
  });

  test("creates a stable named worktree for --wt plus --name (#1768)", async () => {
    repoName = "homelab";
    repoPath = join(parentDir, repoName);
    mkdirSync(repoPath, { recursive: true });
    resolvedOracle = { repoPath, repoName, parentDir };
    sessions = [{ name: "04-homekeeper" }];
    hasSessions = new Set(["04-homekeeper"]);
    detectSessionReturn = "04-homekeeper";
    windowsBySession = {
      "04-homekeeper": [{ index: 0, name: "homekeeper-oracle", active: true, cwd: repoPath }],
    };

    const { result } = await captureLogs(() => cmdWake("homekeeper", { wt: "white", name: "osmosis" }));

    const wtPath = join(parentDir, "homelab.wt-osmosis-white");
    expect(result).toBe("04-homekeeper:homekeeper-osmosis-white");
    expect(findWorktreesCalls).toContainEqual({
      parentDir,
      repoName: "homelab",
      taskSlug: "osmosis-white",
      scopeStem: "homekeeper-oracle",
    });
    expect(createdWorktrees).toEqual([
      { repoPath, parentDir, repoName: "homelab", oracle: "homekeeper", name: "osmosis-white", deps: { fresh: false, named: true } },
    ]);
    expect(newWindowCalls).toContainEqual({
      session: "04-homekeeper",
      name: "homekeeper-osmosis-white",
      opts: { cwd: wtPath },
    });
  });

  test("--pick forces the reusable worktree picker even for a single fuzzy match (#1768)", async () => {
    repoName = "homelab";
    repoPath = join(parentDir, repoName);
    mkdirSync(repoPath, { recursive: true });
    resolvedOracle = { repoPath, repoName, parentDir };
    sessions = [{ name: "04-homekeeper" }];
    hasSessions = new Set(["04-homekeeper"]);
    detectSessionReturn = "04-homekeeper";
    windowsBySession = {
      "04-homekeeper": [{ index: 0, name: "homekeeper-oracle", active: true, cwd: repoPath }],
    };
    worktrees = [{ name: "2-white", path: join(parentDir, "homelab.wt-2-white") }];
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1";

    const { result } = await captureLogs(() => cmdWake("homekeeper", { wt: "white", pick: true }));

    expect(result).toBe("04-homekeeper:homekeeper-white");
    expect(createdWorktrees).toEqual([]);
    expect(newWindowCalls).toContainEqual({
      session: "04-homekeeper",
      name: "homekeeper-white",
      opts: { cwd: join(parentDir, "homelab.wt-2-white") },
    });
  });

  test("creates a wake-bud worktree, stamps lineage, emits birth signal, and launches with prompt", async () => {
    branchName = "feature/fix-a";

    const { result } = await captureLogs(() =>
      cmdWake("mawjs", {
        task: "Fix A",
        bud: true,
        signalOnBirth: true,
        prompt: "hello oracle",
        engine: "codex",
      }),
    );

    const wtPath = join(parentDir, `${repoName}.wt-fix-a`);
    expect(result).toBe("54-mawjs:mawjs-fix-a");
    expect(createdWorktrees).toEqual([
      { repoPath, parentDir, repoName, oracle: "mawjs", name: "fix-a", deps: { fresh: false, named: false } },
    ]);
    expect(newWindowCalls).toContainEqual({
      session: "54-mawjs",
      name: "mawjs-fix-a",
      opts: { cwd: wtPath },
    });
    expect(sendTextCalls).toContainEqual({
      target: "54-mawjs:mawjs-fix-a",
      text: `cd ${wtPath} && codex --agent mawjs-fix-a -p 'hello oracle'`,
    });
    expect(writeSignalCalls).toEqual([
      {
        root: repoPath,
        child: "mawjs-fix-a",
        signal: expect.objectContaining({ kind: "info" }),
      },
    ]);
    const lineagePath = join(wtPath, "ψ", ".lineage.yaml");
    expect(existsSync(lineagePath)).toBe(true);
    const lineage = readFileSync(lineagePath, "utf8");
    expect(lineage).toContain('budded_from: "mawjs"');
    expect(lineage).toContain('task: "fix-a"');
    expect(lineage).toContain('branch: "feature/fix-a"');
  });
});
