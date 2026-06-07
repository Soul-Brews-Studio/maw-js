import { beforeEach, describe, expect, mock, test } from "bun:test";

type WindowInfo = { name: string };
type WorktreeInfo = { name: string; path: string };

const repoPath = "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle";
const parentDir = "/tmp/ghq/github.com/Soul-Brews-Studio";
const repoName = "neo-oracle";

let logs: string[] = [];
let stdoutWrites: string[] = [];
let hostExecCalls: string[] = [];
let ghqFindCalls: string[] = [];
let ghqFindReturn: string | null = null;
let listSessionsReturn: Array<{ name: string }> = [];
let hasSessionReturn = true;
let detectSessionReturn: string | null = "54-neo";
let shouldWake = false;
let listWindowsReturn: WindowInfo[] = [];
let findWorktreesReturn: WorktreeInfo[] = [];
let claudeSessionsReturn: any[] = [];
let snapshotReturn: any = null;
let snapshotSessionReturn: any = null;
let reusableWorktreeReturn: WorktreeInfo | null = null;
let paneCommand: string | null = "codex";
let restoreTabOrderReturn = 0;
let ensureSessionRunningReturn = 0;
let ensureTeamConfigReturn = false;
let configAgents: Record<string, string> = {};
let savedConfigs: any[] = [];
let capacityChecks: string[] = [];
let setEnvCalls: string[] = [];
let lifecycleCalls: any[] = [];
let newSessions: Array<{ session: string; opts: any }> = [];
let newWindows: Array<{ session: string; window: string; opts: any }> = [];
let sentText: Array<{ target: string; text: string }> = [];
let selectedWindows: string[] = [];
let attachCalls: string[] = [];
let splitCalls: string[] = [];
let openCalls: string[] = [];
let snapshots: string[] = [];
let worktreeCreates: any[] = [];
let lineageWrites: any[] = [];

function resetState(): void {
  logs = [];
  stdoutWrites = [];
  hostExecCalls = [];
  ghqFindCalls = [];
  ghqFindReturn = null;
  listSessionsReturn = [];
  hasSessionReturn = true;
  detectSessionReturn = "54-neo";
  shouldWake = false;
  listWindowsReturn = [];
  findWorktreesReturn = [];
  claudeSessionsReturn = [];
  snapshotReturn = null;
  snapshotSessionReturn = null;
  reusableWorktreeReturn = null;
  paneCommand = "codex";
  restoreTabOrderReturn = 0;
  ensureSessionRunningReturn = 0;
  ensureTeamConfigReturn = false;
  configAgents = {};
  savedConfigs = [];
  capacityChecks = [];
  setEnvCalls = [];
  lifecycleCalls = [];
  newSessions = [];
  newWindows = [];
  sentText = [];
  selectedWindows = [];
  attachCalls = [];
  splitCalls = [];
  openCalls = [];
  snapshots = [];
  worktreeCreates = [];
  lineageWrites = [];
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
    hostExecCalls.push(cmd);
    if (cmd.includes("branch --show-current")) return "feature/quote\n";
    return "";
  },
  restoreTabOrder: async () => restoreTabOrderReturn,
  takeSnapshot: async (trigger: string) => { snapshots.push(trigger); },
  getPaneInfos: async (targets: string[]) => Object.fromEntries(
    targets.map((target) => [target, { command: paneCommand }]),
  ),
  isAgentCommand: (command: string | null | undefined) => command === "codex" || command === "claude",
  tmux: {
    hasSession: async () => hasSessionReturn,
    listSessions: async () => listSessionsReturn,
    listWindows: async () => listWindowsReturn,
    newSession: async (session: string, opts: any) => { newSessions.push({ session, opts }); },
    newWindow: async (session: string, window: string, opts: any) => { newWindows.push({ session, window, opts }); },
    sendText: async (target: string, text: string) => { sentText.push({ target, text }); },
    selectWindow: async (target: string) => { selectedWindows.push(target); },
    setEnvironment: async () => {},
  },
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async (slug: string) => {
    ghqFindCalls.push(slug);
    return ghqFindReturn;
  },
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  buildCommandInDir: (windowName: string, cwd: string, engine?: string) =>
    `cd ${cwd} && ${engine ?? "codex"} --agent ${windowName}`,
  cfgTimeout: () => 0,
  loadConfig: () => ({ node: "m5", agents: configAgents }),
  saveConfig: (patch: any) => { savedConfigs.push(patch); },
}));

mock.module(import.meta.resolve("../../src/core/fleet/validate"), () => ({
  assertValidOracleName: (name: string) => {
    if (name.endsWith("-view")) throw new Error("invalid oracle view name");
  },
}));

mock.module(import.meta.resolve("../../src/core/fleet/claude-sessions"), () => ({
  listClaudeSessions: async () => claudeSessionsReturn,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-resolve"), () => ({
  resolveOracle: async () => ({ repoPath, repoName, parentDir }),
  findWorktrees: async () => findWorktreesReturn,
  findReusableWorktreeBySlug: () => reusableWorktreeReturn,
  getSessionMap: () => ({}),
  resolveFleetSession: () => null,
  detectSession: async () => detectSessionReturn,
  setSessionEnv: async (session: string) => { setEnvCalls.push(session); },
  sanitizeBranchName: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^$/, "task"),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-session"), () => ({
  attachToSession: async (session: string) => { attachCalls.push(session); },
  reconcileParentClaudeDir: async () => {},
  ensureSessionRunning: async () => ensureSessionRunningReturn,
  createWorktree: async (...args: any[]) => {
    worktreeCreates.push(args);
    return { wtPath: "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle.wt-new", windowName: "neo-new" };
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-maybe-split"), () => ({
  maybeOpenWindow: async (target: string) => { openCalls.push(target); },
  maybeSplit: async (target: string) => { splitCalls.push(target); },
}));

mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runWakeLifecycleHooks: async (input: any) => {
    lifecycleCalls.push(input);
    return { phase: "wake", ran: 0, skipped: 0, failed: 0 };
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-target"), () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => {},
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-concurrency"), () => ({
  assertAgentCapacity: async (oracle: string) => { capacityChecks.push(oracle); },
}));

mock.module(import.meta.resolve("../../src/core/fleet/snapshot"), () => ({
  latestSnapshot: () => snapshotReturn,
  loadSnapshot: () => snapshotReturn,
}));

mock.module(import.meta.resolve("../../src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: shouldWake, reason: shouldWake ? "missing" : "already-live" }),
}));

mock.module(import.meta.resolve("../../src/commands/plugins/team/ensure-config"), () => ({
  ensureTeamConfig: () => ensureTeamConfigReturn,
}));

const { cmdWake, _wtPicker, promptAmbiguousWorktreePick } = await import(
  "../../src/commands/shared/wake-cmd.ts?wake-cmd-eleventh-pass-coverage"
);

beforeEach(resetState);

describe("wake-cmd eleventh-pass isolated coverage", () => {
  test("interactive picker returns the selected candidate and rejects invalid choices", async () => {
    const originalIsTTY = _wtPicker.isStdoutTTY;
    const originalReadChoice = _wtPicker.readChoice;
    try {
      _wtPicker.isStdoutTTY = () => true;
      _wtPicker.readChoice = () => "2";
      const candidates = [
        { name: "1-alpha", path: "/repo.wt-1-alpha" },
        { name: "2-alpha", path: "/repo.wt-2-alpha" },
      ];
      const picked = await captureLogs(() => promptAmbiguousWorktreePick("alpha", candidates));
      expect(picked).toBe(candidates[1]);
      expect(stdoutWrites).toEqual(["  Select [1-2]: "]);
      expect(plain()).toContain("'alpha' matches 2 worktrees");

      _wtPicker.readChoice = () => "nope";
      expect(promptAmbiguousWorktreePick("alpha", candidates)).toBeNull();
      _wtPicker.readChoice = () => "3";
      expect(promptAmbiguousWorktreePick("alpha", candidates)).toBeNull();
    } finally {
      _wtPicker.isStdoutTTY = originalIsTTY;
      _wtPicker.readChoice = originalReadChoice;
    }
  });

  test("list mode prints non-empty worktrees with aggregated Claude session summaries", async () => {
    findWorktreesReturn = [
      { name: "1-alpha", path: "/tmp/repo.wt-1-alpha" },
      { name: "2-beta", path: "/tmp/repo.wt-2-beta" },
    ];
    claudeSessionsReturn = [
      {
        projectPath: "/tmp/repo.wt-1-alpha",
        status: "ended",
        lastActivityAt: "2026-05-17T00:00:00.000Z",
        messageCount: 2,
      },
      {
        projectPath: "/tmp/repo.wt-1-alpha",
        status: "active",
        lastActivityAt: "2026-05-18T00:00:00.000Z",
        messageCount: 3,
      },
      {
        projectPath: "/tmp/not-requested",
        status: "active",
        lastActivityAt: "2026-05-18T00:00:00.000Z",
        messageCount: 99,
      },
    ];

    const result = await captureLogs(() => cmdWake("neo", { repoPath, listWt: true }));

    expect(result).toBe("neo:list");
    const text = plain();
    expect(text).toContain("Worktrees for neo (2)");
    expect(text).toContain("1-alpha");
    expect(text).toContain("active · 5 msgs · last");
    expect(text).toContain("2-beta");
  });

  test("incubate dry-run clones through ghq and defaults a reusable worktree slug", async () => {
    detectSessionReturn = null;
    shouldWake = true;
    ghqFindReturn = "/tmp/ghq/github.com/Soul-Brews-Studio/seed-oracle";

    const result = await captureLogs(() =>
      cmdWake("seed", { incubate: "Soul-Brews-Studio/seed-oracle", dryRun: true }),
    );

    expect(result).toBe("seed:dry-run");
    expect(hostExecCalls).toEqual(["ghq get -u github.com/Soul-Brews-Studio/seed-oracle"]);
    expect(ghqFindCalls).toEqual(["github.com/Soul-Brews-Studio/seed-oracle"]);
    const text = plain();
    expect(text).toContain("incubating Soul-Brews-Studio/seed-oracle");
    expect(text).toContain("would wake worktree/task: seedoracle");
  });

  test("missing sessions create a prefixed workspace, restore snapshot windows, rehydrate worktrees, and record the live main window", async () => {
    detectSessionReturn = null;
    shouldWake = true;
    listSessionsReturn = [{ name: "02-old" }, { name: "09-busy" }];
    listWindowsReturn = [{ name: "neo-oracle" }];
    snapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [{ name: "09-neo", windows: [{ name: "neo-snap" }] }] };
    snapshotSessionReturn = null;
    findWorktreesReturn = [{ name: "1-alpha", path: "/tmp/repo.wt-1-alpha" }];
    ensureTeamConfigReturn = true;
    restoreTabOrderReturn = 2;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true, engine: "claude" }));

    expect(result).toBe("10-neo:neo-oracle");
    expect(capacityChecks).toEqual(["neo"]);
    expect(newSessions).toEqual([{ session: "10-neo", opts: { window: "neo-oracle", cwd: repoPath } }]);
    expect(setEnvCalls).toEqual(["10-neo"]);
    expect(savedConfigs).toEqual([{ agents: { neo: "m5" } }]);
    expect(lifecycleCalls).toEqual([{ oracle: "neo", session: "10-neo", repoPath, repoName }]);
    expect(newWindows).toEqual([
      { session: "10-neo", window: "neo-snap", opts: { cwd: repoPath } },
      { session: "10-neo", window: "neo-alpha", opts: { cwd: "/tmp/repo.wt-1-alpha" } },
    ]);
    expect(sentText).toContainEqual({
      target: "10-neo:neo-oracle",
      text: `cd ${repoPath} && claude --agent neo-oracle`,
    });
    expect(sentText).toContainEqual({
      target: "10-neo:neo-snap",
      text: `cd ${repoPath} && claude --agent neo-snap`,
    });
    expect(sentText).toContainEqual({
      target: "10-neo:neo-alpha",
      text: "cd /tmp/repo.wt-1-alpha && claude --agent neo-alpha",
    });
    expect(splitCalls).toEqual(["10-neo:neo-oracle"]);
    expect(openCalls).toEqual(["10-neo:neo-oracle"]);
    expect(snapshots).toEqual(["wake"]);
    const text = plain();
    expect(text).toContain("created session '10-neo'");
    expect(text).toContain("team 'neo' auto-created");
    expect(text).toContain("snapshot restore: 1 window");
    expect(text).toContain("2 window(s) reordered");
  });

  test("task wake reuses a scoped worktree, writes bud lineage and birth signal, and sends an escaped prompt to a new window", async () => {
    listWindowsReturn = [{ name: "neo-oracle" }];
    reusableWorktreeReturn = { name: "old-stable", path: "/tmp/neo.wt-o'hai" };

    const result = await captureLogs(() =>
      cmdWake("neo", {
        repoPath,
        task: "ship it",
        name: "stable",
        bud: true,
        signalOnBirth: true,
        prompt: "don't stop",
        attach: true,
        engine: "codex",
      }),
    );

    expect(result).toBe("54-neo:neo-stable");
    expect(hostExecCalls).toEqual(["git -C '/tmp/neo.wt-o'\\''hai' branch --show-current 2>/dev/null || true"]);
    expect(capacityChecks).toEqual(["neo"]);
    expect(newWindows).toEqual([{ session: "54-neo", window: "neo-stable", opts: { cwd: "/tmp/neo.wt-o'hai" } }]);
    expect(sentText.at(-1)).toEqual({
      target: "54-neo:neo-stable",
      text: "cd /tmp/neo.wt-o'hai && codex --agent neo-stable -p 'don'\\''t stop'",
    });
    expect(attachCalls).toEqual(["54-neo"]);
    expect(splitCalls).toEqual(["54-neo:neo-stable"]);
    expect(openCalls).toEqual(["54-neo:neo-stable"]);
    expect(snapshots).toEqual(["wake"]);
    expect(plain()).toContain("lineage: /tmp/neo.wt-o'hai/ψ/.lineage.yaml");
    expect(plain()).toContain("signal: /tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle/ψ/memory/signals/");
  });
});
