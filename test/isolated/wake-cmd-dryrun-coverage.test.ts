import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

type Session = { name: string };
type Worktree = { name: string; path: string };

const realSdk = await import("../../src/sdk");
const realGhq = await import("../../src/core/ghq");
const realConfig = await import("../../src/config");
const realWakeResolve = await import("../../src/commands/shared/wake-resolve");
const realWakeSession = await import("../../src/commands/shared/wake-session");
const realWakeMaybeSplit = await import("../../src/commands/shared/wake-maybe-split");
const realLifecycle = await import("../../src/plugin/lifecycle");
const realWakeTarget = await import("../../src/commands/shared/wake-target");
const realWakeConcurrency = await import("../../src/commands/shared/wake-concurrency");
const realSnapshot = await import("../../src/core/fleet/snapshot");
const realWakeHelpers = await import("../../src/commands/shared/wake-cmd-helpers");
const realShouldAutoWake = await import("../../src/commands/shared/should-auto-wake");

let parseWakeTargetReturn: any = null;
let ensureClonedCalls: string[] = [];
let ghqFindCalls: string[] = [];
let ghqFindReturn: string | null = null;
let hostExecCalls: string[] = [];
let liveTileRolesRaw = "";
let listSessionsReturn: Session[] = [];
let hasSessionReturn = true;
let listWindowsReturn: Array<{ name: string }> = [];
let resolveOracleCalls: Array<{ oracle: string; allLocal?: boolean }> = [];
let resolveOracleReturn = {
  repoPath: "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle",
  repoName: "neo-oracle",
  parentDir: "/tmp/ghq/github.com/Soul-Brews-Studio",
};
let findWorktreesCalls: Array<{ parentDir: string; repoName: string }> = [];
let findWorktreesReturn: Worktree[] = [];
let sessionMap: Record<string, string> = {};
let fleetSessionReturn: string | null = null;
let detectSessionCalls: Array<{ oracle: string; urlRepoName?: string }> = [];
let detectSessionReturn: string | null = null;
let shouldAutoWakeReturn = { wake: false, reason: "already-live" };
let latestSnapshotReturn: any = null;
let loadSnapshotReturn: any = null;
let findWakeSnapshotSessionReturn: any = null;
let planSnapshotRestoreReturn: Array<{ windowName: string; cwd: string }> = [];
let planRehydrateReturn: Array<{ windowName: string; path: string }> = [];

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = originalLog;
  }
}

function plain(logs: string[]): string {
  return logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return liveTileRolesRaw;
  },
  restoreTabOrder: async () => 0,
  takeSnapshot: async () => {},
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  tmux: {
    hasSession: async () => hasSessionReturn,
    listSessions: async () => listSessionsReturn,
    listWindows: async () => listWindowsReturn,
    newSession: async () => {},
    newWindow: async () => {},
    sendText: async () => {},
    selectWindow: async () => {},
    setEnvironment: async () => {},
  },
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ...realGhq,
  ghqFind: async (slug: string) => {
    ghqFindCalls.push(slug);
    return ghqFindReturn;
  },
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  ...mockConfigModule(() => ({ node: "m5" } as any)),
  buildCommandInDir: (name: string, cwd: string) => `${name}@${cwd}`,
  cfgTimeout: () => 0,
  loadConfig: () => ({ node: "m5" }),
  saveConfig: () => {},
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-resolve"), () => ({
  ...realWakeResolve,
  resolveOracle: async (oracle: string, opts?: { allLocal?: boolean }) => {
    resolveOracleCalls.push({ oracle, allLocal: opts?.allLocal });
    return resolveOracleReturn;
  },
  findWorktrees: async (parentDir: string, repoName: string) => {
    findWorktreesCalls.push({ parentDir, repoName });
    return findWorktreesReturn;
  },
  findReusableWorktreeBySlug: () => null,
  getSessionMap: () => sessionMap,
  resolveFleetSession: () => fleetSessionReturn,
  detectSession: async (oracle: string, urlRepoName?: string) => {
    detectSessionCalls.push({ oracle, urlRepoName });
    return detectSessionReturn;
  },
  setSessionEnv: async () => {},
  sanitizeBranchName: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ""),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-session"), () => ({
  ...realWakeSession,
  attachToSession: async () => {},
  ensureSessionRunning: async () => 0,
  createWorktree: async () => ({ wtPath: "/tmp/worktree", windowName: "neo-task" }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-maybe-split"), () => ({
  ...realWakeMaybeSplit,
  maybeOpenWindow: async () => {},
  maybeSplit: async () => {},
}));

mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  ...realLifecycle,
  runWakeLifecycleHooks: async () => ({ phase: "wake", ran: 0, skipped: 0, failed: 0 }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-target"), () => ({
  ...realWakeTarget,
  parseWakeTarget: () => parseWakeTargetReturn,
  ensureCloned: async (slug: string) => {
    ensureClonedCalls.push(slug);
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-concurrency"), () => ({
  ...realWakeConcurrency,
  assertAgentCapacity: async () => {},
}));

mock.module(import.meta.resolve("../../src/core/fleet/snapshot"), () => ({
  ...realSnapshot,
  latestSnapshot: () => latestSnapshotReturn,
  loadSnapshot: () => loadSnapshotReturn,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd-helpers"), () => ({
  ...realWakeHelpers,
  findWakeSnapshotSession: () => findWakeSnapshotSessionReturn,
  planRehydrateWorktreeWindows: () => planRehydrateReturn,
  planSnapshotRestoreWindows: () => planSnapshotRestoreReturn,
  retryFreshSessionTmuxStep: async (_session: string, _label: string, fn: () => unknown) => await fn(),
  shouldOfferExistingSessionAttach: () => false,
  waitForTmuxSessionReady: async () => {},
  writeWakeBudBirthSignal: async () => {},
  writeWakeBudLineage: async () => {},
}));

mock.module(import.meta.resolve("../../src/commands/shared/should-auto-wake"), () => ({
  ...realShouldAutoWake,
  shouldAutoWake: () => shouldAutoWakeReturn,
}));

const { cmdWake } = await import("../../src/commands/shared/wake-cmd.ts?wake-cmd-dryrun-coverage");

beforeEach(() => {
  parseWakeTargetReturn = null;
  ensureClonedCalls = [];
  ghqFindCalls = [];
  ghqFindReturn = null;
  hostExecCalls = [];
  liveTileRolesRaw = "";
  listSessionsReturn = [];
  hasSessionReturn = true;
  listWindowsReturn = [];
  resolveOracleCalls = [];
  resolveOracleReturn = {
    repoPath: "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle",
    repoName: "neo-oracle",
    parentDir: "/tmp/ghq/github.com/Soul-Brews-Studio",
  };
  findWorktreesCalls = [];
  findWorktreesReturn = [];
  sessionMap = {};
  fleetSessionReturn = null;
  detectSessionCalls = [];
  detectSessionReturn = null;
  shouldAutoWakeReturn = { wake: false, reason: "already-live" };
  latestSnapshotReturn = null;
  loadSnapshotReturn = null;
  findWakeSnapshotSessionReturn = null;
  planSnapshotRestoreReturn = [];
  planRehydrateReturn = [];
});

describe("wake-cmd dry-run and early branch coverage", () => {
  test("rejects invalid foreign session names before tmux lookup", async () => {
    await expect(cmdWake("neo", { session: "bad session", dryRun: true })).rejects.toThrow(
      "invalid target session",
    );
    expect(detectSessionCalls).toEqual([]);
  });

  test("parsed org/repo targets preserve clone path and log bud/task dry-run hints", async () => {
    parseWakeTargetReturn = { slug: "Soul-Brews-Studio/neo-oracle", oracle: "neo" };
    ghqFindReturn = "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle";
    shouldAutoWakeReturn = { wake: true, reason: "missing" };

    const { result, logs } = await captureLogs(() =>
      cmdWake("neo/", { dryRun: true, task: "hotfix", bud: true, signalOnBirth: true }),
    );

    expect(result).toBe("neo:dry-run");
    expect(ensureClonedCalls).toEqual(["Soul-Brews-Studio/neo-oracle"]);
    expect(ghqFindCalls).toEqual(["/Soul-Brews-Studio/neo-oracle"]);
    const text = plain(logs);
    expect(text).toContain("dry-run — no tmux sessions/windows will be changed");
    expect(text).toContain("would wake worktree/task: hotfix");
    expect(text).toContain("would stamp wake-bud lineage for neo");
    expect(text).toContain("would drop wake-bud birth signal");
  });

  test("repoPath list mode skips repo resolution and prints empty worktree state", async () => {
    const repoPath = "/tmp/ghq/github.com/Soul-Brews-Studio/foo-oracle";

    const { result, logs } = await captureLogs(() =>
      cmdWake("foo", { repoPath, listWt: true }),
    );

    expect(result).toBe("foo:list");
    expect(resolveOracleCalls).toEqual([]);
    expect(findWorktreesCalls).toEqual([
      { parentDir: "/tmp/ghq/github.com/Soul-Brews-Studio", repoName: "foo-oracle" },
    ]);
    expect(plain(logs)).toContain("No worktrees for foo.");
  });

  test("incubate dry-run clones via ghq, defaults worktree slug, and plans a numbered session", async () => {
    ghqFindReturn = "/tmp/ghq/github.com/Soul-Brews-Studio/maw-js";
    listSessionsReturn = [{ name: "07-old" }];
    shouldAutoWakeReturn = { wake: true, reason: "missing" };

    const { result, logs } = await captureLogs(() =>
      cmdWake("neo", { incubate: "Soul-Brews-Studio/maw-js", dryRun: true }),
    );

    expect(result).toBe("neo:dry-run");
    expect(hostExecCalls).toEqual(["ghq get -u github.com/Soul-Brews-Studio/maw-js"]);
    expect(ghqFindCalls).toEqual(["github.com/Soul-Brews-Studio/maw-js"]);
    const text = plain(logs);
    expect(text).toContain("incubating Soul-Brews-Studio/maw-js...");
    expect(text).toContain("would create session '08-neo'");
    expect(text).toContain("would wake worktree/task: mawjs");
  });

  test("foreign workspace sessions dry-run without requiring rehydrate planning", async () => {
    hasSessionReturn = false;
    resolveOracleReturn = {
      repoPath: "/tmp/ghq/github.com/Soul-Brews-Studio/token-oracle",
      repoName: "token-oracle",
      parentDir: "/tmp/ghq/github.com/Soul-Brews-Studio",
    };

    const { result, logs } = await captureLogs(() =>
      cmdWake("token", { session: "dev-work", dryRun: true, noRehydrate: true }),
    );

    expect(result).toBe("dev-work:token");
    const text = plain(logs);
    expect(text).toContain("target workspace session: dev-work");
    expect(text).toContain("would wake window 'token' in workspace session 'dev-work'");
    expect(text).toContain("worktree rehydrate skipped (foreign workspace session)");
  });

  test("numeric fleet targets reuse the exact live session during dry-run", async () => {
    listSessionsReturn = [{ name: "48-foo" }];
    shouldAutoWakeReturn = { wake: false, reason: "already-live" };
    resolveOracleReturn = {
      repoPath: "/tmp/ghq/github.com/Soul-Brews-Studio/foo-oracle",
      repoName: "foo-oracle",
      parentDir: "/tmp/ghq/github.com/Soul-Brews-Studio",
    };

    const { result, logs } = await captureLogs(() =>
      cmdWake("48-foo", { dryRun: true, noRehydrate: true }),
    );

    expect(result).toBe("48-foo:foo-oracle");
    expect(detectSessionCalls).toEqual([]);
    expect(plain(logs)).toContain("would reuse session: 48-foo");
  });

  test("session map numeric names are used as-is for missing-session dry-runs", async () => {
    sessionMap = { neo: "48-neo" };
    shouldAutoWakeReturn = { wake: true, reason: "missing" };

    const { result, logs } = await captureLogs(() =>
      cmdWake("neo", { dryRun: true, noRehydrate: true }),
    );

    expect(result).toBe("neo:dry-run");
    expect(plain(logs)).toContain("would create session '48-neo' (main: neo-oracle)");
  });

  test("snapshot id requests name the missing snapshot in the failure", async () => {
    await expect(cmdWake("neo", { fromSnapshot: true, snapshotId: "wake-404", dryRun: true })).rejects.toThrow(
      "snapshot not found: wake-404",
    );
  });

  test("snapshot requests fail loudly when no snapshot exists or the session is absent", async () => {
    await expect(cmdWake("neo", { fromSnapshot: true, dryRun: true })).rejects.toThrow(
      "no snapshot found",
    );

    latestSnapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [] };
    await expect(cmdWake("neo", { fromSnapshot: true, dryRun: true })).rejects.toThrow(
      "has no session for neo",
    );
  });
});
