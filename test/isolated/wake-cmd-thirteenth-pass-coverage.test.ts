import { beforeEach, describe, expect, mock, test } from "bun:test";

type WindowInfo = { name: string };
type WorktreeInfo = { name: string; path: string };

const repoPath = "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle";
const parentDir = "/tmp/ghq/github.com/Soul-Brews-Studio";
const repoName = "neo-oracle";

let logs: string[] = [];
let stdoutWrites: string[] = [];
let liveTileRolesRaw = "";
let hostExecCalls: string[] = [];
let listSessionsReturn: Array<{ name: string }> = [];
let listSessionsThrows = false;
let hasSessionReturn = true;
let listWindowsReturn: WindowInfo[] = [];
let listWindowsThrows = false;
let detectSessionReturn: string | null = "54-neo";
let detectSessionCalls: Array<{ oracle: string; urlRepoName?: string }> = [];
let shouldWake = false;
let findWorktreesReturn: WorktreeInfo[] = [];
let findWorktreesCalls: any[] = [];
let claudeSessionsReturn: any[] = [];
let claudeSessionsThrows = false;
let sessionMapReturn: Record<string, string> = {};
let fleetSessionReturn: string | null = null;
let snapshotReturn: any = null;
let snapshotSessionReturn: any = null;
let plannedSnapshotWindows: Array<{ windowName: string; cwd: string; source?: string }> = [];
let plannedRehydrateWindows: Array<{ windowName: string; path: string }> = [];
let paneCommand: string | null = "codex";
let restoreTabOrderReturn = 0;
let ensureSessionRunningReturn = 0;
let configAgents: Record<string, string> = { neo: "m5" };
let savedConfigs: any[] = [];
let ensureTeamConfigReturn = false;
let offerAttachPrompt = false;
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
let respawnCalls: any[][] = [];
let tmuxRunAvailable = true;
let worktreeCreates: any[] = [];
let lineageWrites: any[] = [];
let birthSignalWrites: any[] = [];
let parseWakeTargetReturn: null | { slug: string; oracle: string } = null;
let ghqFindReturn: string | null = null;

function resetState(): void {
  logs = [];
  stdoutWrites = [];
  liveTileRolesRaw = "";
  hostExecCalls = [];
  listSessionsReturn = [];
  listSessionsThrows = false;
  hasSessionReturn = true;
  listWindowsReturn = [{ name: "neo-oracle" }];
  listWindowsThrows = false;
  detectSessionReturn = "54-neo";
  detectSessionCalls = [];
  shouldWake = false;
  findWorktreesReturn = [];
  findWorktreesCalls = [];
  claudeSessionsReturn = [];
  claudeSessionsThrows = false;
  sessionMapReturn = {};
  fleetSessionReturn = null;
  snapshotReturn = null;
  snapshotSessionReturn = null;
  plannedSnapshotWindows = [];
  plannedRehydrateWindows = [];
  paneCommand = "codex";
  restoreTabOrderReturn = 0;
  ensureSessionRunningReturn = 0;
  configAgents = { neo: "m5" };
  savedConfigs = [];
  ensureTeamConfigReturn = false;
  offerAttachPrompt = false;
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
  respawnCalls = [];
  tmuxRunAvailable = true;
  worktreeCreates = [];
  lineageWrites = [];
  birthSignalWrites = [];
  parseWakeTargetReturn = null;
  ghqFindReturn = null;
}

async function captureLogs<T>(fn: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
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
    if (cmd.includes("branch --show-current")) return "feature/thirteen\n";
    return liveTileRolesRaw;
  },
  restoreTabOrder: async () => restoreTabOrderReturn,
  takeSnapshot: async (trigger: string) => {
    snapshots.push(trigger);
  },
  getPaneInfos: async (targets: string[]) => Object.fromEntries(
    targets.map((target) => [target, { command: paneCommand }]),
  ),
  isAgentCommand: (command: string | null | undefined) => command === "codex" || command === "claude",
  tmux: {
    hasSession: async () => hasSessionReturn,
    listSessions: async () => {
      if (listSessionsThrows) throw new Error("list-sessions failed");
      return listSessionsReturn;
    },
    listWindows: async () => {
      if (listWindowsThrows) throw new Error("list-windows failed");
      return listWindowsReturn;
    },
    newSession: async (session: string, opts: any) => {
      newSessions.push({ session, opts });
    },
    newWindow: async (session: string, window: string, opts: any) => {
      newWindows.push({ session, window, opts });
    },
    sendText: async (target: string, text: string) => {
      sentText.push({ target, text });
    },
    selectWindow: async (target: string) => {
      selectedWindows.push(target);
    },
    setEnvironment: async () => {},
    get run() {
      return tmuxRunAvailable
        ? async (...args: any[]) => {
          respawnCalls.push(args);
          return "";
        }
        : undefined;
    },
  },
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async () => ghqFindReturn,
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  buildCommandInDir: (windowName: string, cwd: string, engine?: string) =>
    `cd ${cwd} && ${engine ?? "codex"} --agent ${windowName}`,
  cfgTimeout: () => 0,
  loadConfig: () => ({ node: "m5", agents: configAgents }),
  saveConfig: (patch: any) => {
    savedConfigs.push(patch);
  },
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
  findWorktrees: async (...args: any[]) => {
    findWorktreesCalls.push(args);
    return findWorktreesReturn;
  },
  findReusableWorktreeBySlug: () => null,
  getSessionMap: () => sessionMapReturn,
  resolveFleetSession: () => fleetSessionReturn,
  detectSession: async (oracle: string, urlRepoName?: string) => {
    detectSessionCalls.push({ oracle, urlRepoName });
    return detectSessionReturn;
  },
  setSessionEnv: async (session: string) => {
    setEnvCalls.push(session);
  },
  sanitizeBranchName: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^$/, "task"),
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-session"), () => ({
  attachToSession: async (session: string) => {
    attachCalls.push(session);
  },
  ensureSessionRunning: async () => ensureSessionRunningReturn,
  createWorktree: async (...args: any[]) => {
    worktreeCreates.push(args);
    return { wtPath: "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle.wt-new", windowName: "neo-new" };
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-maybe-split"), () => ({
  maybeOpenWindow: async (target: string) => {
    openCalls.push(target);
  },
  maybeSplit: async (target: string) => {
    splitCalls.push(target);
  },
}));

mock.module(import.meta.resolve("../../src/plugin/lifecycle"), () => ({
  runWakeLifecycleHooks: async (input: any) => {
    lifecycleCalls.push(input);
    return { phase: "wake", ran: 0, skipped: 0, failed: 0 };
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-target"), () => ({
  parseWakeTarget: () => parseWakeTargetReturn,
  ensureCloned: async () => {},
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-concurrency"), () => ({
  assertAgentCapacity: async (oracle: string) => {
    capacityChecks.push(oracle);
  },
}));

mock.module(import.meta.resolve("../../src/core/fleet/snapshot"), () => ({
  latestSnapshot: () => snapshotReturn,
  loadSnapshot: () => snapshotReturn,
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd-helpers"), () => ({
  buildWakeBudLineage: () => "",
  findWakeSnapshotSession: () => snapshotSessionReturn,
  planRehydrateWorktreeWindows: () => plannedRehydrateWindows,
  planSnapshotRestoreWindows: () => plannedSnapshotWindows,
  retryFreshSessionTmuxStep: async (_session: string, _label: string, fn: () => unknown) => await fn(),
  shouldOfferExistingSessionAttach: () => offerAttachPrompt,
  waitForTmuxSessionReady: async () => {},
  writeWakeBudBirthSignal: (...args: any[]) => {
    birthSignalWrites.push(args);
    return "/tmp/repo/ψ/memory/signals/neo-new.json";
  },
  writeWakeBudLineage: (...args: any[]) => {
    lineageWrites.push(args);
    return "/tmp/worktree/ψ/memory/wake-bud-lineage.json";
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: shouldWake, reason: shouldWake ? "missing" : "already-live" }),
}));

mock.module(import.meta.resolve("../../src/commands/plugins/team/ensure-config"), () => ({
  ensureTeamConfig: () => ensureTeamConfigReturn,
}));

const {
  cmdWake,
  getLiveTileRoles,
  _wtPicker,
  promptAmbiguousWorktreePick,
} = await import("../../src/commands/shared/wake-cmd");

beforeEach(resetState);

describe("wake-cmd thirteenth-pass isolated coverage", () => {
  test("exported helpers cover live tile parsing, failures, and picker defaults", async () => {
    await expect(getLiveTileRoles("54-neo", {
      hostExecFn: async () => "main\n\n side \nmain\n",
    })).resolves.toEqual(new Set(["main", "side"]));

    await expect(getLiveTileRoles("54-neo", {
      hostExecFn: async () => {
        throw new Error("tmux unavailable");
      },
    })).resolves.toEqual(new Set());

    expect(typeof _wtPicker.isStdoutTTY()).toBe("boolean");
    expect(_wtPicker.readChoice()).toBeNull();

    mock.module("node:tty", () => ({
      isatty: () => {
        throw new Error("tty unavailable");
      },
    }));
    expect(_wtPicker.isStdoutTTY()).toBe(false);
  });

  test("interactive picker handles valid, empty, non-numeric, and out-of-range choices", async () => {
    const originalIsTTY = _wtPicker.isStdoutTTY;
    const originalReadChoice = _wtPicker.readChoice;
    const candidates = [
      { name: "1-alpha", path: "/repo.wt-1-alpha" },
      { name: "2-alpha", path: "/repo.wt-2-alpha" },
    ];
    try {
      _wtPicker.isStdoutTTY = () => true;
      _wtPicker.readChoice = () => "1";
      expect(await captureLogs(() => promptAmbiguousWorktreePick("alpha", candidates))).toBe(candidates[0]);
      expect(stdoutWrites).toEqual(["  Select [1-2]: "]);

      _wtPicker.readChoice = () => "";
      expect(promptAmbiguousWorktreePick("alpha", candidates)).toBeNull();
      _wtPicker.readChoice = () => "nope";
      expect(promptAmbiguousWorktreePick("alpha", candidates)).toBeNull();
      _wtPicker.readChoice = () => "9";
      expect(promptAmbiguousWorktreePick("alpha", candidates)).toBeNull();
    } finally {
      _wtPicker.isStdoutTTY = originalIsTTY;
      _wtPicker.readChoice = originalReadChoice;
    }
  });

  test("list mode renders now, minute, hour, day, and merged session summaries", async () => {
    const now = Date.now();
    findWorktreesReturn = [
      { name: "1-now", path: "/tmp/neo-oracle.wt-1-now" },
      { name: "2-min", path: "/tmp/neo-oracle.wt-2-min" },
      { name: "3-hour", path: "/tmp/neo-oracle.wt-3-hour" },
      { name: "4-day", path: "/tmp/neo-oracle.wt-4-day" },
    ];
    claudeSessionsReturn = [
      {
        projectPath: "/tmp/neo-oracle.wt-1-now",
        status: "ended",
        lastActivityAt: new Date(now - 90_000).toISOString(),
        messageCount: 1,
      },
      {
        projectPath: "/tmp/neo-oracle.wt-1-now",
        status: "active",
        lastActivityAt: new Date(now - 20_000).toISOString(),
        messageCount: 2,
      },
      {
        projectPath: "/tmp/neo-oracle.wt-2-min",
        status: "idle",
        lastActivityAt: new Date(now - 5 * 60_000).toISOString(),
        messageCount: 1,
      },
      {
        projectPath: "/tmp/neo-oracle.wt-3-hour",
        status: "ended",
        lastActivityAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        messageCount: 4,
      },
      {
        projectPath: "/tmp/neo-oracle.wt-4-day",
        status: "ended",
        lastActivityAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
        messageCount: 5,
      },
    ];

    const result = await captureLogs(() => cmdWake("neo", { repoPath, listWt: true }));

    expect(result).toBe("neo:list");
    const text = plain();
    expect(text).toContain("active · 3 msgs · last now");
    expect(text).toContain("idle · 1 msg · last 5m ago");
    expect(text).toContain("ended · 4 msgs · last 2h ago");
    expect(text).toContain("ended · 5 msgs · last 2d ago");
  });

  test("list mode tolerates Claude session scan failures for non-empty worktrees", async () => {
    findWorktreesReturn = [{ name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" }];
    claudeSessionsThrows = true;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, listWt: true }));

    expect(result).toBe("neo:list");
    expect(plain()).toContain("Worktrees for neo (1)");
    expect(plain()).toContain("1-alpha");
    expect(plain()).not.toContain("msgs");
  });

  test("repo path dry-run renames fuzzy oracle aliases to the resolved oracle stem", async () => {
    const result = await captureLogs(() =>
      cmdWake("alias", { repoPath, dryRun: true, noRehydrate: true }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(detectSessionCalls).toEqual([{ oracle: "neo", urlRepoName: undefined }]);
    expect(plain()).toContain("would reuse session: 54-neo");
  });

  test("default dry-run resolves through resolveOracle when no path shortcut is supplied", async () => {
    const result = await captureLogs(() => cmdWake("neo", { dryRun: true, noRehydrate: true, allLocal: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(plain()).toContain("found Soul-Brews-Studio/neo-oracle");
    expect(plain()).toContain("would reuse session: 54-neo");
  });

  test("full repo target dry-run preserves parsed clone path and url repo name", async () => {
    parseWakeTargetReturn = { slug: "Soul-Brews-Studio/neo-oracle", oracle: "neo" };
    ghqFindReturn = repoPath;
    detectSessionReturn = null;
    shouldWake = true;
    listSessionsReturn = [{ name: "09-other" }];

    const result = await captureLogs(() => cmdWake("Soul-Brews-Studio/neo-oracle", { dryRun: true }));

    expect(result).toBe("neo:dry-run");
    expect(detectSessionCalls).toEqual([{ oracle: "neo", urlRepoName: "neo-oracle" }]);
    expect(plain()).toContain("would create session '10-neo' (main: neo-oracle)");
  });

  test("incubate dry-run prefixes short slugs and defaults the worktree slug", async () => {
    ghqFindReturn = repoPath;
    detectSessionReturn = null;
    shouldWake = true;

    const result = await captureLogs(() => cmdWake("neo", { incubate: "Soul-Brews-Studio/neo-oracle", dryRun: true, bud: true, signalOnBirth: true }));

    expect(result).toBe("neo:dry-run");
    expect(hostExecCalls).toContain("ghq get -u github.com/Soul-Brews-Studio/neo-oracle");
    expect(plain()).toContain("would wake worktree/task: neooracle");
    expect(plain()).toContain("would stamp wake-bud lineage");
    expect(plain()).toContain("would drop wake-bud birth signal");
  });

  test("incubate dry-run without explicit task still defaults the worktree slug", async () => {
    ghqFindReturn = repoPath;
    detectSessionReturn = null;
    shouldWake = true;

    const result = await captureLogs(() => cmdWake("neo", { incubate: "github.com/Soul-Brews-Studio/neo-oracle", dryRun: true }));

    expect(result).toBe("neo:dry-run");
    expect(hostExecCalls).toContain("ghq get -u github.com/Soul-Brews-Studio/neo-oracle");
    expect(plain()).toContain("would wake worktree/task: neooracle");
  });

  test("foreign session dry-run validates, skips rehydrate, and reports missing sessions", async () => {
    let result = await captureLogs(() => cmdWake("neo", { repoPath, session: "workspace", dryRun: true }));

    expect(result).toBe("workspace:neo");
    expect(plain()).toContain("would wake window 'neo' in workspace session 'workspace'");
    expect(plain()).toContain("worktree rehydrate skipped (foreign workspace session)");

    await expect(captureLogs(() => cmdWake("neo", { repoPath, session: "bad/session" })))
      .rejects.toThrow("invalid target session 'bad/session'");

    hasSessionReturn = false;
    await expect(captureLogs(() => cmdWake("neo", { repoPath, session: "missing" })))
      .rejects.toThrow("target session 'missing' not found");
  });

  test("dry-run snapshot planning reports empty and concrete restore windows", async () => {
    snapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [{ name: "54-neo", windows: [] }] };
    snapshotSessionReturn = { name: "54-neo", windows: [] };
    findWorktreesReturn = [{ name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" }];

    plannedSnapshotWindows = [];
    let result = await captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true, dryRun: true }));
    expect(result).toBe("54-neo:neo-oracle");
    expect(plain()).toContain("would restore snapshot windows: none");

    logs = [];
    plannedSnapshotWindows = [{ windowName: "neo-alpha", cwd: "/tmp/neo-oracle.wt-1-alpha", source: "worktree" }];
    result = await captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true, dryRun: true }));
    expect(result).toBe("54-neo:neo-oracle");
    expect(plain()).toContain("would restore snapshot window: neo-alpha");

    snapshotSessionReturn = null;
    await expect(captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true })))
      .rejects.toThrow("snapshot 2026-05-18T00:00:00.000Z has no session for neo");
  });

  test("dry-run reports concrete worktree rehydrate plans", async () => {
    findWorktreesReturn = [{ name: "5-docs", path: "/tmp/neo-oracle.wt-5-docs" }];
    plannedRehydrateWindows = [{ windowName: "neo-docs", path: "/tmp/neo-oracle.wt-5-docs" }];

    const result = await captureLogs(() => cmdWake("neo", { repoPath, dryRun: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(plain()).toContain("would respawn: neo-docs");
    expect(plain()).toContain("/tmp/neo-oracle.wt-5-docs");
  });

  test("invalid bud flag combinations and missing snapshots fail before tmux mutation", async () => {
    await expect(captureLogs(() => cmdWake("neo", { repoPath, bud: true })))
      .rejects.toThrow("--bud requires --task <slug> or --wt <slug>");

    await expect(captureLogs(() => cmdWake("neo", { repoPath, task: "seed", signalOnBirth: true })))
      .rejects.toThrow("--signal-on-birth requires --bud");

    snapshotReturn = null;
    await expect(captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true, snapshotId: "snap-missing" })))
      .rejects.toThrow("snapshot not found: snap-missing");
  });

  test("numeric live targets pre-resolve exact tmux sessions and preserve stripped oracle lookup", async () => {
    listSessionsReturn = [{ name: "54-neo" }];

    const result = await captureLogs(() => cmdWake("54-neo", { repoPath, noRehydrate: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(detectSessionCalls).toEqual([]);
    expect(plain()).toContain("session exists: 54-neo");
  });

  test("session listing races fall back during numeric and new-session planning", async () => {
    listSessionsThrows = true;
    detectSessionReturn = null;
    shouldWake = true;

    let result = await captureLogs(() => cmdWake("neo", { repoPath, dryRun: true, noRehydrate: true }));

    expect(result).toBe("neo:dry-run");
    expect(plain()).toContain("would create session '01-neo'");

    resetState();
    listSessionsThrows = true;
    detectSessionReturn = null;
    shouldWake = true;
    result = await captureLogs(() => cmdWake("54-neo", { repoPath, dryRun: true, noRehydrate: true }));

    expect(result).toBe("neo:dry-run");
    expect(detectSessionCalls).toEqual([{ oracle: "neo", urlRepoName: undefined }]);
    expect(plain()).toContain("would create session '01-neo'");
  });

  test("dry-run treats window listing failures as empty when planning rehydrate", async () => {
    listWindowsThrows = true;
    findWorktreesReturn = [{ name: "5-docs", path: "/tmp/neo-oracle.wt-5-docs" }];
    plannedRehydrateWindows = [{ windowName: "neo-docs", path: "/tmp/neo-oracle.wt-5-docs" }];

    const result = await captureLogs(() => cmdWake("neo", { repoPath, dryRun: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(plain()).toContain("would respawn: neo-docs");
  });

  test("missing session creation registers new agents and reports team auto-config", async () => {
    detectSessionReturn = null;
    shouldWake = true;
    listSessionsReturn = [{ name: "02-old" }];
    listWindowsReturn = [];
    configAgents = {};
    ensureTeamConfigReturn = true;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, noRehydrate: true }));

    expect(result).toBe("03-neo:neo-oracle");
    expect(savedConfigs).toEqual([{ agents: { neo: "m5" } }]);
    expect(plain()).toContain("registered agent 'neo' → 'm5'");
    expect(plain()).toContain("team 'neo' auto-created");
  });

  test("missing session creation tolerates post-create window listing failures", async () => {
    detectSessionReturn = null;
    shouldWake = true;
    listSessionsReturn = [{ name: "02-old" }];
    listWindowsThrows = true;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, noRehydrate: true }));

    expect(result).toBe("03-neo:neo-oracle");
    expect(newSessions).toEqual([{ session: "03-neo", opts: { window: "neo-oracle", cwd: repoPath } }]);
    expect(plain()).toContain("created session '03-neo'");
  });

  test("existing sessions restore snapshots and rehydrate worktrees before ensuring panes", async () => {
    snapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [{ name: "54-neo", windows: [] }] };
    snapshotSessionReturn = { name: "54-neo", windows: [{ name: "neo-docs" }] };
    plannedSnapshotWindows = [{ windowName: "neo-docs", cwd: "/tmp/neo-oracle.wt-docs", source: "worktree" }];
    findWorktreesReturn = [{ name: "3-review", path: "/tmp/neo-oracle.wt-3-review" }];
    plannedRehydrateWindows = [{ windowName: "neo-review", path: "/tmp/neo-oracle.wt-3-review" }];
    ensureSessionRunningReturn = 2;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(newWindows).toEqual([
      { session: "54-neo", window: "neo-docs", opts: { cwd: "/tmp/neo-oracle.wt-docs" } },
      { session: "54-neo", window: "neo-review", opts: { cwd: "/tmp/neo-oracle.wt-3-review" } },
    ]);
    expect(sentText).toContainEqual({
      target: "54-neo:neo-docs",
      text: "cd /tmp/neo-oracle.wt-docs && codex --agent neo-docs",
    });
    expect(sentText).toContainEqual({
      target: "54-neo:neo-review",
      text: "cd /tmp/neo-oracle.wt-3-review && codex --agent neo-review",
    });
    expect(plain()).toContain("snapshot restore: 1 window");
    expect(plain()).toContain("2 window(s) retried.");
  });

  test("missing sessions restore snapshot windows, rehydrate worktrees, and reuse the live main window", async () => {
    detectSessionReturn = null;
    shouldWake = true;
    listSessionsReturn = [{ name: "03-old" }];
    listWindowsReturn = [];
    snapshotReturn = { timestamp: "2026-05-18T00:00:00.000Z", sessions: [{ name: "04-neo", windows: [] }] };
    snapshotSessionReturn = { name: "04-neo", windows: [{ name: "neo-restored" }] };
    plannedSnapshotWindows = [{ windowName: "neo-restored", cwd: "/tmp/restore-root", source: "repo" }];
    findWorktreesReturn = [{ name: "2-beta", path: "/tmp/neo-oracle.wt-2-beta" }];
    plannedRehydrateWindows = [{ windowName: "neo-beta", path: "/tmp/neo-oracle.wt-2-beta" }];
    restoreTabOrderReturn = 1;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, fromSnapshot: true, engine: "claude" }));

    expect(result).toBe("04-neo:neo-oracle");
    expect(capacityChecks).toEqual(["neo"]);
    expect(newSessions).toEqual([{ session: "04-neo", opts: { window: "neo-oracle", cwd: repoPath } }]);
    expect(setEnvCalls).toEqual(["04-neo"]);
    expect(savedConfigs).toEqual([]);
    expect(lifecycleCalls).toEqual([{ oracle: "neo", session: "04-neo", repoPath, repoName }]);
    expect(newWindows).toEqual([
      { session: "04-neo", window: "neo-restored", opts: { cwd: "/tmp/restore-root" } },
      { session: "04-neo", window: "neo-beta", opts: { cwd: "/tmp/neo-oracle.wt-2-beta" } },
    ]);
    expect(sentText).toContainEqual({
      target: "04-neo:neo-oracle",
      text: `cd ${repoPath} && claude --agent neo-oracle`,
    });
    expect(sentText).toContainEqual({
      target: "04-neo:neo-restored",
      text: "cd /tmp/restore-root && claude --agent neo-restored",
    });
    expect(sentText).toContainEqual({
      target: "04-neo:neo-beta",
      text: "cd /tmp/neo-oracle.wt-2-beta && claude --agent neo-beta",
    });
    expect(snapshots).toEqual(["wake"]);
    expect(plain()).toContain("snapshot window: neo-restored");
    expect(plain()).toContain("1 window(s) reordered");
  });

  test("existing live windows can switch engine through tmux respawn-pane", async () => {
    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, noRehydrate: true, engine: "claude", attach: true }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(respawnCalls).toEqual([
      ["respawn-pane", "-k", "-t", "54-neo:neo-oracle", `cd ${repoPath} && claude --agent neo-oracle`],
    ]);
    expect(sentText).toEqual([]);
    expect(selectedWindows).toEqual(["54-neo:neo-oracle"]);
    expect(attachCalls).toEqual(["54-neo"]);
    expect(splitCalls).toEqual(["54-neo:neo-oracle"]);
    expect(openCalls).toEqual(["54-neo:neo-oracle"]);
    expect(snapshots).toEqual(["wake"]);
  });

  test("existing live prompt and engine switches fall back to sendText when respawn-pane is unavailable", async () => {
    tmuxRunAvailable = false;

    let result = await captureLogs(() =>
      cmdWake("neo", { repoPath, noRehydrate: true, prompt: "quote 'this'", engine: "claude", attach: true }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(sentText).toEqual([{
      target: "54-neo:neo-oracle",
      text: `cd ${repoPath} && claude --agent neo-oracle -p 'quote '\\''this'\\'''`,
    }]);
    expect(selectedWindows).toEqual(["54-neo:neo-oracle"]);
    expect(attachCalls).toEqual(["54-neo"]);

    resetState();
    tmuxRunAvailable = false;
    result = await captureLogs(() =>
      cmdWake("neo", { repoPath, noRehydrate: true, engine: "claude" }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(sentText).toEqual([{
      target: "54-neo:neo-oracle",
      text: `cd ${repoPath} && claude --agent neo-oracle`,
    }]);
    expect(respawnCalls).toEqual([]);
  });

  test("existing live prompt without engine sends the escaped prompt directly", async () => {
    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, noRehydrate: true, prompt: "plain 'prompt'" }),
    );

    expect(result).toBe("54-neo:neo-oracle");
    expect(sentText).toEqual([{
      target: "54-neo:neo-oracle",
      text: `cd ${repoPath} && codex --agent neo-oracle -p 'plain '\\''prompt'\\'''`,
    }]);
    expect(respawnCalls).toEqual([]);
  });

  test("existing live windows offer attach and continue when tty answer is unavailable", async () => {
    offerAttachPrompt = true;

    const result = await captureLogs(() => cmdWake("neo", { repoPath, noRehydrate: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(stdoutWrites).toContain("  attach? [y/N] ");
    expect(selectedWindows).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(splitCalls).toEqual(["54-neo:neo-oracle"]);
    expect(openCalls).toEqual(["54-neo:neo-oracle"]);
    expect(snapshots).toEqual(["wake"]);
  });

  test("--pick requires an interactive choice even when a candidate exists", async () => {
    findWorktreesReturn = [{ name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" }];

    await expect(captureLogs(() =>
      cmdWake("neo", { repoPath, task: "alpha", pick: true }),
    )).rejects.toThrow("--pick requires an interactive selection for 'alpha'");
  });

  test("--pick accepts an interactive ambiguous worktree choice", async () => {
    const originalIsTTY = _wtPicker.isStdoutTTY;
    const originalReadChoice = _wtPicker.readChoice;
    findWorktreesReturn = [
      { name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" },
      { name: "2-alpha", path: "/tmp/neo-oracle.wt-2-alpha" },
    ];
    try {
      _wtPicker.isStdoutTTY = () => true;
      _wtPicker.readChoice = () => "2";

      const result = await captureLogs(() =>
        cmdWake("neo", { repoPath, task: "alpha", prompt: "selected", pick: true }),
      );

      expect(result).toBe("54-neo:neo-alpha");
      expect(worktreeCreates).toEqual([]);
      expect(newWindows).toEqual([
        { session: "54-neo", window: "neo-alpha", opts: { cwd: "/tmp/neo-oracle.wt-2-alpha" } },
      ]);
      expect(sentText.at(-1)).toEqual({
        target: "54-neo:neo-alpha",
        text: "cd /tmp/neo-oracle.wt-2-alpha && codex --agent neo-alpha -p 'selected'",
      });
    } finally {
      _wtPicker.isStdoutTTY = originalIsTTY;
      _wtPicker.readChoice = originalReadChoice;
    }
  });

  test("ambiguous worktree reuse accepts the interactive picker without --pick", async () => {
    const originalIsTTY = _wtPicker.isStdoutTTY;
    const originalReadChoice = _wtPicker.readChoice;
    findWorktreesReturn = [
      { name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" },
      { name: "2-alpha", path: "/tmp/neo-oracle.wt-2-alpha" },
    ];
    try {
      _wtPicker.isStdoutTTY = () => true;
      _wtPicker.readChoice = () => "1";

      const result = await captureLogs(() => cmdWake("neo", { repoPath, wt: "alpha" }));

      expect(result).toBe("54-neo:neo-alpha");
      expect(worktreeCreates).toEqual([]);
      expect(newWindows).toEqual([
        { session: "54-neo", window: "neo-alpha", opts: { cwd: "/tmp/neo-oracle.wt-1-alpha" } },
      ]);
    } finally {
      _wtPicker.isStdoutTTY = originalIsTTY;
      _wtPicker.readChoice = originalReadChoice;
    }
  });

  test("ambiguous worktree reuse fails loudly when the interactive picker declines", async () => {
    findWorktreesReturn = [
      { name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" },
      { name: "2-alpha", path: "/tmp/neo-oracle.wt-2-alpha" },
    ];

    await expect(captureLogs(() => cmdWake("neo", { repoPath, wt: "alpha" })))
      .rejects.toThrow("'alpha' is ambiguous — matches 2 worktrees");
  });

  test("new bud worktrees write lineage and birth signals before launching plain prompts", async () => {
    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, task: "Birth Task", bud: true, signalOnBirth: true }),
    );

    expect(result).toBe("54-neo:neo-new");
    expect(worktreeCreates[0]?.slice(0, 5)).toEqual([
      repoPath,
      parentDir,
      repoName,
      "neo",
      "birthtask",
    ]);
    expect(lineageWrites).toEqual([
      ["/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle.wt-new", {
        parentOracle: "neo",
        task: "birthtask",
        branch: "feature/thirteen",
      }],
    ]);
    expect(birthSignalWrites).toEqual([
      [repoPath, "neo-birthtask", {
        parentOracle: "neo",
        task: "birthtask",
        branch: "feature/thirteen",
        worktreePath: "/tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle.wt-new",
      }],
    ]);
    expect(sentText.at(-1)).toEqual({
      target: "54-neo:neo-new",
      text: "cd /tmp/ghq/github.com/Soul-Brews-Studio/neo-oracle.wt-new && codex --agent neo-new",
    });
  });

  test("fuzzy worktree reuse launches a new prompted window with attach", async () => {
    findWorktreesReturn = [{ name: "1-alpha", path: "/tmp/neo-oracle.wt-1-alpha" }];

    const result = await captureLogs(() =>
      cmdWake("neo", { repoPath, task: "alpha", prompt: "ship now", attach: true }),
    );

    expect(result).toBe("54-neo:neo-alpha");
    expect(worktreeCreates).toEqual([]);
    expect(capacityChecks).toEqual(["neo"]);
    expect(newWindows).toEqual([
      { session: "54-neo", window: "neo-alpha", opts: { cwd: "/tmp/neo-oracle.wt-1-alpha" } },
    ]);
    expect(sentText.at(-1)).toEqual({
      target: "54-neo:neo-alpha",
      text: "cd /tmp/neo-oracle.wt-1-alpha && codex --agent neo-alpha -p 'ship now'",
    });
    expect(attachCalls).toEqual(["54-neo"]);
    expect(splitCalls).toEqual(["54-neo:neo-alpha"]);
    expect(openCalls).toEqual(["54-neo:neo-alpha"]);
    expect(snapshots).toEqual(["wake"]);
  });

  test("dead existing windows relaunch, and unreliable window listings refuse duplicate creation", async () => {
    paneCommand = "zsh";
    let result = await captureLogs(() => cmdWake("neo", { repoPath, noRehydrate: true, attach: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(sentText).toContainEqual({
      target: "54-neo:neo-oracle",
      text: `cd ${repoPath} && codex --agent neo-oracle`,
    });
    expect(selectedWindows).toEqual(["54-neo:neo-oracle"]);
    expect(attachCalls).toEqual(["54-neo"]);

    resetState();
    listWindowsThrows = true;
    await expect(captureLogs(() => cmdWake("neo", { repoPath, task: "new" })))
      .rejects.toThrow("could not list windows for session '54-neo'");
  });

  test("plain live existing windows attach without relaunching", async () => {
    paneCommand = "codex";
    listWindowsReturn = [{ name: "neo-oracle" }];

    const result = await captureLogs(() => cmdWake("neo", { repoPath, noRehydrate: true, attach: true }));

    expect(result).toBe("54-neo:neo-oracle");
    expect(sentText).toEqual([]);
    expect(respawnCalls).toEqual([]);
    expect(selectedWindows).toEqual(["54-neo:neo-oracle"]);
    expect(attachCalls).toEqual(["54-neo"]);
    expect(splitCalls).toEqual(["54-neo:neo-oracle"]);
    expect(openCalls).toEqual(["54-neo:neo-oracle"]);
  });
});
