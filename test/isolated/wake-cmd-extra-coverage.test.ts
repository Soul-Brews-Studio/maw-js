import { beforeEach, describe, expect, mock, test } from "bun:test";

type WindowInfo = { name: string };
type WorktreeInfo = { name: string; path: string };

let repoPath = "";
let repoName = "";
let parentDir = "";
let detectSessionReturn: string | null = null;
let hasSessionReturn = true;
let listWindowsReturn: WindowInfo[] = [];
let listWindowsThrows = false;
let worktreesReturn: WorktreeInfo[] = [];
let snapshotReturn: any = null;
let snapshotSessionReturn: any = null;
let plannedSnapshotWindows: Array<{ windowName: string; cwd: string; source?: string }> = [];
let paneCommand = "codex";

let logs: string[] = [];
let selectedWindows: string[] = [];
let sentText: Array<{ target: string; text: string }> = [];
let snapshots: string[] = [];
let setEnvCalls: string[] = [];
let ensureSessionRunningCalls: string[] = [];
let maybeSplitCalls: string[] = [];
let maybeOpenWindowCalls: string[] = [];

function resetState(): void {
  parentDir = "/tmp/ghq/github.com/Soul-Brews-Studio";
  repoName = "neo-oracle";
  repoPath = `${parentDir}/${repoName}`;
  detectSessionReturn = "54-neo";
  hasSessionReturn = true;
  listWindowsReturn = [{ name: "neo-oracle" }];
  listWindowsThrows = false;
  worktreesReturn = [];
  snapshotReturn = null;
  snapshotSessionReturn = null;
  plannedSnapshotWindows = [];
  paneCommand = "codex";

  logs = [];
  selectedWindows = [];
  sentText = [];
  snapshots = [];
  setEnvCalls = [];
  ensureSessionRunningCalls = [];
  maybeSplitCalls = [];
  maybeOpenWindowCalls = [];
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  hostExec: async () => "",
  restoreTabOrder: async () => 0,
  takeSnapshot: async (trigger: string) => {
    snapshots.push(trigger);
  },
  getPaneInfos: async (targets: string[]) => Object.fromEntries(
    targets.map((target) => [target, { command: paneCommand }]),
  ),
  isAgentCommand: (command: string | null | undefined) => command === "codex",
  tmux: {
    hasSession: async () => hasSessionReturn,
    listSessions: async () => [],
    listWindows: async () => {
      if (listWindowsThrows) throw new Error("tmux list failed");
      return listWindowsReturn;
    },
    newSession: async () => {},
    newWindow: async () => {},
    sendText: async (target: string, text: string) => {
      sentText.push({ target, text });
    },
    selectWindow: async (target: string) => {
      selectedWindows.push(target);
    },
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

mock.module(import.meta.resolve("../../src/commands/shared/wake-resolve"), () => ({
  resolveOracle: async () => ({ repoPath, repoName, parentDir }),
  findWorktrees: async () => worktreesReturn,
  findReusableWorktreeBySlug: () => null,
  getSessionMap: () => ({}),
  resolveFleetSession: () => null,
  detectSession: async () => detectSessionReturn,
  setSessionEnv: async (session: string) => {
    setEnvCalls.push(session);
  },
  sanitizeBranchName: (value: string) => value,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-session"), () => ({
  attachToSession: async () => {},
  reconcileParentClaudeDir: async () => {},
  ensureSessionRunning: async (session: string) => {
    ensureSessionRunningCalls.push(session);
    return 0;
  },
  createWorktree: async () => ({ wtPath: "/tmp/worktree", windowName: "neo-task" }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-maybe-split"), () => ({
  maybeOpenWindow: async (target: string) => {
    maybeOpenWindowCalls.push(target);
  },
  maybeSplit: async (target: string) => {
    maybeSplitCalls.push(target);
  },
}));

mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runWakeLifecycleHooks: async () => ({ phase: "wake", ran: 0, skipped: 0, failed: 0 }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-target"), () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => {},
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-concurrency"), () => ({
  assertAgentCapacity: async () => {},
}));

mock.module(import.meta.resolve("../../src/core/fleet/snapshot"), () => ({
  latestSnapshot: () => snapshotReturn,
  loadSnapshot: () => snapshotReturn,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd-helpers"), () => ({
  buildWakeBudLineage: () => "",
  findWakeSnapshotSession: () => snapshotSessionReturn,
  planRehydrateWorktreeWindows: () => [],
  planSnapshotRestoreWindows: () => plannedSnapshotWindows,
  retryFreshSessionTmuxStep: async (_session: string, _label: string, fn: () => unknown) => await fn(),
  shouldOfferExistingSessionAttach: () => false,
  waitForTmuxSessionReady: async () => {},
  writeWakeBudBirthSignal: () => "",
  writeWakeBudLineage: () => "",
}));

mock.module(import.meta.resolve("../../src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: Boolean(!detectSessionReturn), reason: detectSessionReturn ? "already-live" : "missing" }),
}));

const { cmdWake } = await import("../../src/commands/shared/wake-cmd.ts?wake-cmd-extra-coverage");

beforeEach(resetState);

describe("wake-cmd extra isolated coverage", () => {
  test("rejects bud options that cannot produce lineage", async () => {
    await expect(captureLogs(() => cmdWake("neo", { repoPath, bud: true }))).rejects.toThrow(
      "--bud requires --task <slug> or --wt <slug>",
    );

    await expect(captureLogs(() => cmdWake("neo", { repoPath, signalOnBirth: true }))).rejects.toThrow(
      "--signal-on-birth requires --bud",
    );
  });

  test("dry-run previews requested snapshot windows before skipping rehydrate", async () => {
    snapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [] };
    snapshotSessionReturn = { name: "54-neo", windows: [{ name: "neo-task" }] };
    plannedSnapshotWindows = [
      { windowName: "neo-task", cwd: `${parentDir}/neo-oracle.wt-task`, source: "worktree" },
    ];

    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, dryRun: true, fromSnapshot: true, noRehydrate: true }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(logs.join("\n")).toContain("would restore snapshot window: neo-task");
    expect(logs.join("\n")).toContain("worktree rehydrate skipped (--main/--solo/--no-rehydrate)");
  });

  test("sends escaped prompts to an existing wake window and snapshots the wake", async () => {
    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, noRehydrate: true, prompt: "it's alive", engine: "codex" }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(setEnvCalls).toEqual(["54-neo"]);
    expect(ensureSessionRunningCalls).toEqual(["54-neo"]);
    expect(selectedWindows).toEqual(["54-neo:neo-oracle"]);
    expect(sentText).toEqual([
      {
        target: "54-neo:neo-oracle",
        text: `cd ${repoPath} && codex --agent neo-oracle -p 'it'\\''s alive'`,
      },
    ]);
    expect(maybeSplitCalls).toEqual(["54-neo:neo-oracle"]);
    expect(maybeOpenWindowCalls).toEqual(["54-neo:neo-oracle"]);
    expect(snapshots).toEqual(["wake"]);
  });

  test("refuses to create a wake window when existing window listing is unreliable", async () => {
    listWindowsThrows = true;
    listWindowsReturn = [];

    await expect(
      captureLogs(() => cmdWake("neo", { repoPath, noRehydrate: true, task: "new-work" })),
    ).rejects.toThrow("could not list windows for session '54-neo'");
  });

  test("errors when a requested foreign workspace session is missing", async () => {
    hasSessionReturn = false;

    await expect(captureLogs(() => cmdWake("neo", { repoPath, session: "project-dev" }))).rejects.toThrow(
      "target session 'project-dev' not found",
    );
  });
});
