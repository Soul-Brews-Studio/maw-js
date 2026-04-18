/**
 * wake-cmd.ts — cmdWake() is the `maw wake <oracle>` entry. Big branching:
 *   - input normalize + -view reject
 *   - --incubate: ghq-clone slug, default wt
 *   - detectSession hit vs. miss (create new session, auto-register agent)
 *   - worktree auto-spawn on session create + re-spawn on respawn-to-existing
 *   - --list-wt (early return)
 *   - --new-wt / --task: resolveWorktreeTarget (exact / fuzzy / ambiguous / none)
 *     + --fresh bypass, createWorktree fallback
 *   - existing-window detection (exact name or NN-prefix sibling)
 *   - --prompt (escape single quotes) + --attach
 *   - --split (TMUX env gate) + graceful cmdSplit failure
 *   - tail: restoreTabOrder, takeSnapshot
 *
 * Isolated because wake-cmd pulls in the whole sdk barrel (tmux, ssh,
 * fleet, snapshot, tab-order), and mock.module is process-global.
 *
 * Strategy:
 *   - Mock at wake-cmd's own direct seams: ./wake-resolve, ./wake-session,
 *     ../../core/ghq, and split/impl. Each uses the `mockActive` gate +
 *     passthrough so other isolated tests see real behavior.
 *   - Mock transport at the source: tmux module + ssh module. These are
 *     stubbed during our tests and passthrough otherwise.
 *   - Mock config for saveConfig (never write the user's real maw config)
 *     + deterministic buildCommandInDir/cfgTimeout during our tests.
 *   - Mock tab-order + snapshot for clean fire-and-forget end-of-flow.
 *
 * Key pattern from bud-wake (#375): capture real function REFS (not the
 * namespace) before mock.module installs — bun's mock.module replaces the
 * namespace object, so `real.fn` after mocking points to our wrapper →
 * infinite recursion hang. Binding each function here preserves originals.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mockSshModule } from "../helpers/mock-ssh";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rWakeResolve = await import("../../src/commands/shared/wake-resolve");
const realFetchIssuePrompt = _rWakeResolve.fetchIssuePrompt;
const realFetchGitHubPrompt = _rWakeResolve.fetchGitHubPrompt;
const realResolveOracle = _rWakeResolve.resolveOracle;
const realFindWorktrees = _rWakeResolve.findWorktrees;
const realGetSessionMap = _rWakeResolve.getSessionMap;
const realResolveFleetSession = _rWakeResolve.resolveFleetSession;
const realDetectSession = _rWakeResolve.detectSession;
const realSetSessionEnv = _rWakeResolve.setSessionEnv;
const realSanitizeBranchName = _rWakeResolve.sanitizeBranchName;

const _rWakeSession = await import("../../src/commands/shared/wake-session");
const realAttachToSession = _rWakeSession.attachToSession;
const realIsPaneIdle = _rWakeSession.isPaneIdle;
const realEnsureSessionRunning = _rWakeSession.ensureSessionRunning;
const realCreateWorktree = _rWakeSession.createWorktree;

const _rGhq = await import("../../src/core/ghq");
const realGhqFind = _rGhq.ghqFind;

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;
const realSaveConfig = _rConfig.saveConfig;
const realBuildCommandInDir = _rConfig.buildCommandInDir;
const realCfgTimeout = _rConfig.cfgTimeout;

const _rTmux = await import("../../src/core/transport/tmux");
const realTmux = _rTmux.tmux;

const _rTabOrder = await import("../../src/core/fleet/tab-order");
const realRestoreTabOrder = _rTabOrder.restoreTabOrder;

const _rSnapshot = await import("../../src/core/fleet/snapshot");
const realTakeSnapshot = _rSnapshot.takeSnapshot;

const _rSplit = await import("../../src/commands/plugins/split/impl");
const realCmdSplit = _rSplit.cmdSplit;

// ─── State captured by mock wrappers (reset per-test) ───────────────────────

// wake-resolve
let resolveOracleReturn: { repoPath: string; repoName: string; parentDir: string } | Error = {
  repoPath: "/ghq/github.com/Org/foo-oracle",
  repoName: "foo-oracle",
  parentDir: "/ghq/github.com/Org",
};
let findWorktreesReturn: { path: string; name: string }[] = [];
let findWorktreesByPath: Record<string, { path: string; name: string }[]> = {};
let sessionMapReturn: Record<string, string> = {};
let resolveFleetSessionReturn: string | null = null;
let detectSessionReturn: string | null = null;
let setSessionEnvCalls: string[] = [];
// wake-session
let attachToSessionCalls: string[] = [];
let ensureSessionRunningCalls: Array<{ session: string; excludeNames: Set<string> | undefined }> = [];
let ensureSessionRunningReturn = 0;
let createWorktreeCalls: Array<{ repoPath: string; oracle: string; name: string }> = [];
let createWorktreeReturn: { wtPath: string; windowName: string } = {
  wtPath: "/ghq/Org/foo-oracle.wt-1-task",
  windowName: "foo-1-task",
};
// ghq
let ghqFindReturn: string | null = "/ghq/github.com/Org/foo-oracle";
let ghqFindCalls: string[] = [];
// config
let configOverride: any = {
  host: "local",
  port: 3456,
  ghqRoot: "/ghq",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  agents: {},
  node: "local",
};
let saveConfigCalls: Array<Record<string, unknown>> = [];
// tmux
let tmuxCalls: Array<{ op: string; args: unknown[] }> = [];
let tmuxListWindowsByName: Record<string, Array<{ index: number; name: string; active: boolean }>> = {};
let tmuxListWindowsThrowOnce = false;
// tab-order + snapshot
let restoreTabOrderReturn = 0;
let restoreTabOrderCalls: string[] = [];
let takeSnapshotCalls: string[] = [];
// split
let cmdSplitCalls: string[] = [];
let cmdSplitThrow: Error | null = null;
// sdk ssh
let hostExecCalls: string[] = [];
let hostExecThrow: Error | null = null;

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/commands/shared/wake-resolve"),
  () => ({
    fetchIssuePrompt: (...a: any[]) => (mockActive ? "" : (realFetchIssuePrompt as any)(...a)),
    fetchGitHubPrompt: (...a: any[]) => (mockActive ? "" : (realFetchGitHubPrompt as any)(...a)),
    resolveOracle: async (oracle: string) => {
      if (!mockActive) return realResolveOracle(oracle);
      if (resolveOracleReturn instanceof Error) throw resolveOracleReturn;
      return resolveOracleReturn;
    },
    findWorktrees: async (parentDir: string, repoName: string) => {
      if (!mockActive) return realFindWorktrees(parentDir, repoName);
      const key = `${parentDir}/${repoName}`;
      if (key in findWorktreesByPath) return findWorktreesByPath[key]!;
      return findWorktreesReturn;
    },
    getSessionMap: () => (mockActive ? sessionMapReturn : realGetSessionMap()),
    resolveFleetSession: (oracle: string) =>
      mockActive ? resolveFleetSessionReturn : realResolveFleetSession(oracle),
    detectSession: async (oracle: string) =>
      mockActive ? detectSessionReturn : realDetectSession(oracle),
    setSessionEnv: async (session: string) => {
      if (!mockActive) return realSetSessionEnv(session);
      setSessionEnvCalls.push(session);
    },
    sanitizeBranchName: realSanitizeBranchName, // pure, always real
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/shared/wake-session"),
  () => ({
    isPaneIdle: realIsPaneIdle,
    attachToSession: async (session: string) => {
      if (!mockActive) return realAttachToSession(session);
      attachToSessionCalls.push(session);
    },
    ensureSessionRunning: async (...args: any[]) => {
      if (!mockActive) return (realEnsureSessionRunning as any)(...args);
      ensureSessionRunningCalls.push({ session: args[0] as string, excludeNames: args[1] as Set<string> | undefined });
      return ensureSessionRunningReturn;
    },
    createWorktree: async (...args: any[]) => {
      if (!mockActive) return (realCreateWorktree as any)(...args);
      createWorktreeCalls.push({
        repoPath: args[0] as string,
        oracle: args[3] as string,
        name: args[4] as string,
      });
      return createWorktreeReturn;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/core/ghq"),
  () => ({
    ..._rGhq,
    ghqFind: async (query: string) => {
      if (!mockActive) return realGhqFind(query);
      ghqFindCalls.push(query);
      return ghqFindReturn;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: () => (mockActive ? configOverride : realLoadConfig()),
    saveConfig: (partial: Record<string, unknown>) => {
      if (!mockActive) return realSaveConfig(partial as any);
      saveConfigCalls.push(partial);
      // Merge into configOverride so subsequent loadConfig sees the update
      Object.assign(configOverride, partial);
      return configOverride;
    },
    buildCommandInDir: (name: string, cwd: string) =>
      mockActive ? `CMD[${name}@${cwd}]` : realBuildCommandInDir(name, cwd),
    cfgTimeout: (key: any) => (mockActive ? 0 : realCfgTimeout(key)),
  }),
);

// Tmux — minimal surface exercised by wake-cmd; other callers passthrough.
mock.module(
  join(import.meta.dir, "../../src/core/transport/tmux"),
  () => ({
    ..._rTmux,
    tmux: new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return undefined; // not a thenable
        return (...args: unknown[]) => {
          if (!mockActive) return (realTmux as any)[prop](...args);
          tmuxCalls.push({ op: prop, args });
          if (prop === "listWindows") {
            if (tmuxListWindowsThrowOnce) {
              tmuxListWindowsThrowOnce = false;
              return Promise.reject(new Error("no session"));
            }
            const sess = args[0] as string;
            return Promise.resolve(tmuxListWindowsByName[sess] || []);
          }
          return Promise.resolve(undefined);
        };
      },
    }),
  }),
);

mock.module(
  join(import.meta.dir, "../../src/core/transport/ssh"),
  () => mockSshModule({
    hostExec: async (cmd: string) => {
      if (!mockActive) return "";
      hostExecCalls.push(cmd);
      if (hostExecThrow) throw hostExecThrow;
      return "";
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/core/fleet/tab-order"),
  () => ({
    ..._rTabOrder,
    restoreTabOrder: async (session: string) => {
      if (!mockActive) return realRestoreTabOrder(session);
      restoreTabOrderCalls.push(session);
      return restoreTabOrderReturn;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/core/fleet/snapshot"),
  () => ({
    ..._rSnapshot,
    takeSnapshot: async (trigger: string) => {
      if (!mockActive) return realTakeSnapshot(trigger);
      takeSnapshotCalls.push(trigger);
      return "/fake/snapshot";
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/plugins/split/impl"),
  () => ({
    ..._rSplit,
    // Forward ALL args so passthrough preserves opts (noAttach, vertical, pct, …)
    // — dropping them broke split-cascade.test.ts which passes opts positionally.
    cmdSplit: async (...args: any[]) => {
      if (!mockActive) return (realCmdSplit as any)(...args);
      cmdSplitCalls.push(args[0] as string);
      if (cmdSplitThrow) throw cmdSplitThrow;
    },
  }),
);

// NB: load cmdWake AFTER all mock.module calls so its import graph resolves
// through our stubs (bun replaces the module registry at mock.module time).
const { cmdWake } = await import("../../src/commands/shared/wake-cmd");

// ─── Test harness ───────────────────────────────────────────────────────────

const origLog = console.log;
const origErr = console.error;
const origTmux = process.env.TMUX;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
  mockActive = true;
  resolveOracleReturn = {
    repoPath: "/ghq/github.com/Org/foo-oracle",
    repoName: "foo-oracle",
    parentDir: "/ghq/github.com/Org",
  };
  findWorktreesReturn = [];
  findWorktreesByPath = {};
  sessionMapReturn = {};
  resolveFleetSessionReturn = null;
  detectSessionReturn = null;
  setSessionEnvCalls = [];
  attachToSessionCalls = [];
  ensureSessionRunningCalls = [];
  ensureSessionRunningReturn = 0;
  createWorktreeCalls = [];
  createWorktreeReturn = {
    wtPath: "/ghq/Org/foo-oracle.wt-1-task",
    windowName: "foo-1-task",
  };
  ghqFindReturn = "/ghq/github.com/Org/foo-oracle";
  ghqFindCalls = [];
  configOverride = {
    host: "local",
    port: 3456,
    ghqRoot: "/ghq",
    oracleUrl: "http://localhost:47779",
    env: {},
    commands: { default: "claude" },
    sessions: {},
    agents: {},
    node: "local",
  };
  saveConfigCalls = [];
  tmuxCalls = [];
  tmuxListWindowsByName = {};
  tmuxListWindowsThrowOnce = false;
  restoreTabOrderReturn = 0;
  restoreTabOrderCalls = [];
  takeSnapshotCalls = [];
  cmdSplitCalls = [];
  cmdSplitThrow = null;
  hostExecCalls = [];
  hostExecThrow = null;
  delete process.env.TMUX;
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  mockActive = false;
  if (origTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = origTmux;
});

afterAll(() => {
  console.log = origLog;
  console.error = origErr;
  mockActive = false;
});

// Little helpers
const tmuxOp = (op: string) => tmuxCalls.filter(c => c.op === op);

// ─── 1. Input validation (normalizeTarget + assertValidOracleName) ──────────

describe("cmdWake — input validation", () => {
  test("strips trailing `/` from oracle name (tab-completion artifact)", async () => {
    await cmdWake("foo/", {});
    // resolveOracle would be called with the normalized name
    // We can't directly spy on it, but tmux.newSession uses session=oracle
    // (via fallback chain) → session param should be 'foo', not 'foo/'.
    const newSess = tmuxOp("newSession");
    expect(newSess).toHaveLength(1);
    expect(newSess[0].args[0]).toBe("foo");
  });

  test("strips `/.git` suffix (tab-complete from bare repo dir)", async () => {
    await cmdWake("foo/.git", {});
    const newSess = tmuxOp("newSession");
    expect(newSess[0].args[0]).toBe("foo");
  });

  test("rejects `-view` suffix with UserError (before any session work)", async () => {
    let caught: Error | null = null;
    try { await cmdWake("foo-view", {}); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("cannot end in '-view'");
    // Never reached resolveOracle / tmux
    expect(tmuxCalls).toHaveLength(0);
  });
});

// ─── 2. --incubate branch ───────────────────────────────────────────────────

describe("cmdWake — --incubate", () => {
  test("bare slug (no github.com) → prepends github.com/ for ghq get", async () => {
    ghqFindReturn = "/ghq/github.com/some-org/some-repo";
    await cmdWake("newone", { incubate: "some-org/some-repo" });

    expect(hostExecCalls.some(c => c === "ghq get -u github.com/some-org/some-repo")).toBe(true);
    expect(ghqFindCalls.some(q => q.includes("some-org/some-repo"))).toBe(true);
  });

  test("slug with github.com prefix → used as-is", async () => {
    ghqFindReturn = "/ghq/github.com/x/y";
    await cmdWake("one", { incubate: "github.com/x/y" });

    expect(hostExecCalls.some(c => c === "ghq get -u github.com/x/y")).toBe(true);
  });

  test("ghqFind returns null after clone → throws", async () => {
    ghqFindReturn = null;
    let caught: Error | null = null;
    try { await cmdWake("one", { incubate: "x/y" }); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("ghq could not find");
  });

  test("--incubate without --task/--wt → default wt = repoName stripped of dashes", async () => {
    ghqFindReturn = "/ghq/github.com/org/some-repo";
    // When wt is set and findWorktrees returns [], we hit the createWorktree branch.
    findWorktreesReturn = [];
    await cmdWake("one", { incubate: "org/some-repo" });

    // createWorktree should have been called with name = "somerepo" (dashes stripped)
    expect(createWorktreeCalls).toHaveLength(1);
    expect(createWorktreeCalls[0].name).toBe("somerepo");
  });
});

// ─── 3. No session exists — new session creation ────────────────────────────

describe("cmdWake — new session creation (detectSession miss)", () => {
  test("tmux.newSession called with oracle name + main window + cwd=repoPath", async () => {
    detectSessionReturn = null;
    await cmdWake("foo", {});

    const newSess = tmuxOp("newSession");
    expect(newSess).toHaveLength(1);
    expect(newSess[0].args[0]).toBe("foo");
    expect(newSess[0].args[1]).toMatchObject({ window: "foo-oracle", cwd: "/ghq/github.com/Org/foo-oracle" });
  });

  test("setSessionEnv invoked after new session with the resolved session name", async () => {
    await cmdWake("foo", {});
    expect(setSessionEnvCalls).toEqual(["foo"]);
  });

  test("buildCommandInDir used for main window sendText", async () => {
    await cmdWake("foo", {});
    const sends = tmuxOp("sendText");
    // First sendText is for main window
    expect(sends[0].args[0]).toBe("foo:foo-oracle");
    expect(sends[0].args[1]).toBe("CMD[foo-oracle@/ghq/github.com/Org/foo-oracle]");
  });

  test("agent auto-registered in config.agents when oracle absent", async () => {
    configOverride.agents = { other: "remote" };
    configOverride.node = "green";
    await cmdWake("foo", {});

    expect(saveConfigCalls).toHaveLength(1);
    expect(saveConfigCalls[0].agents).toEqual({ other: "remote", foo: "green" });
  });

  test("agent already in config.agents → saveConfig NOT called", async () => {
    configOverride.agents = { foo: "local" };
    await cmdWake("foo", {});
    expect(saveConfigCalls).toHaveLength(0);
  });

  test("session name uses getSessionMap → resolveFleetSession → oracle fallback chain (map hit)", async () => {
    sessionMapReturn = { foo: "custom-session" };
    await cmdWake("foo", {});
    const newSess = tmuxOp("newSession");
    expect(newSess[0].args[0]).toBe("custom-session");
  });

  test("fleet session resolves when sessionMap misses", async () => {
    sessionMapReturn = {};
    resolveFleetSessionReturn = "42-fleet-foo";
    await cmdWake("foo", {});
    const newSess = tmuxOp("newSession");
    expect(newSess[0].args[0]).toBe("42-fleet-foo");
  });

  test("spawns worktree windows when --task/--wt not set", async () => {
    findWorktreesReturn = [
      { path: "/ghq/org/foo-oracle.wt-1-alpha", name: "1-alpha" },
      { path: "/ghq/org/foo-oracle.wt-2-beta", name: "2-beta" },
    ];
    await cmdWake("foo", {});

    const newWins = tmuxOp("newWindow");
    // Main window is via newSession, worktrees via newWindow
    const names = newWins.map(c => c.args[1] as string);
    expect(names).toContain("foo-alpha");
    expect(names).toContain("foo-beta");
  });

  test("worktree name collision → falls back to full wt.name", async () => {
    // Two worktrees that strip to same taskPart — second should use raw name.
    findWorktreesReturn = [
      { path: "/ghq/org/foo-oracle.wt-1-alpha", name: "1-alpha" },
      { path: "/ghq/org/foo-oracle.wt-2-alpha", name: "2-alpha" },
    ];
    await cmdWake("foo", {});
    const names = tmuxOp("newWindow").map(c => c.args[1] as string);
    expect(names).toContain("foo-alpha");
    expect(names).toContain("foo-2-alpha");
  });
});

// ─── 4. Session exists — respawn branch ─────────────────────────────────────

describe("cmdWake — existing session (detectSession hit)", () => {
  test("listWindows queried → preExistingWindows honored", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [
      { index: 0, name: "foo-oracle", active: true },
    ];
    await cmdWake("foo", {});

    // listWindows called twice: once for preExistingWindows, once for
    // existing-window lookup near the end.
    expect(tmuxOp("listWindows").length).toBeGreaterThanOrEqual(1);
    expect(setSessionEnvCalls).toEqual(["foo"]);
  });

  test("respawns missing worktree windows only (skip already-present)", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [
      { index: 0, name: "foo-oracle", active: true },
      { index: 1, name: "foo-alpha", active: false },
    ];
    findWorktreesReturn = [
      { path: "/ghq/org/foo-oracle.wt-1-alpha", name: "1-alpha" }, // already exists
      { path: "/ghq/org/foo-oracle.wt-2-beta", name: "2-beta" },   // missing
    ];
    await cmdWake("foo", {});

    const names = tmuxOp("newWindow").map(c => c.args[1] as string);
    expect(names).toContain("foo-beta");
    expect(names).not.toContain("foo-alpha");
  });

  test("ensureSessionRunning called with preExistingWindows set", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [
      { index: 0, name: "foo-oracle", active: true },
    ];
    ensureSessionRunningReturn = 2;
    await cmdWake("foo", {});

    expect(ensureSessionRunningCalls).toHaveLength(1);
    expect(ensureSessionRunningCalls[0].session).toBe("foo");
    expect(ensureSessionRunningCalls[0].excludeNames?.has("foo-oracle")).toBe(true);
  });
});

// ─── 5. --list-wt (early return) ────────────────────────────────────────────

describe("cmdWake — --list-wt", () => {
  test("returns session:window and logs each worktree", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [
      { path: "/ghq/org/foo-oracle.wt-1-a", name: "1-a" },
    ];
    const logs: string[] = [];
    console.log = (...a) => { logs.push(a.map(String).join(" ")); };

    const ret = await cmdWake("foo", { listWt: true });
    expect(ret).toBe("foo:foo-oracle");
    // Listing block logs the worktree name
    expect(logs.some(l => l.includes("1-a"))).toBe(true);
  });

  test("no worktrees → returns session:window without error", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [];

    const ret = await cmdWake("foo", { listWt: true });
    expect(ret).toBe("foo:foo-oracle");
  });
});

// ─── 6. --new-wt / --task with resolveWorktreeTarget ────────────────────────

describe("cmdWake — --task / --new-wt worktree resolution", () => {
  test("exact match on existing worktree → reuses (no createWorktree)", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [
      { path: "/ghq/Org/foo-oracle.wt-1-payments", name: "1-payments" },
    ];
    // resolveWorktreeTarget("payments", ...) will match "1-payments" via suffix
    await cmdWake("foo", { task: "payments" });

    expect(createWorktreeCalls).toHaveLength(0);
    // newWindow for the reused worktree
    const names = tmuxOp("newWindow").map(c => c.args[1] as string);
    expect(names).toContain("foo-payments");
  });

  test("no match → createWorktree is called with sanitized name", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [];
    createWorktreeReturn = {
      wtPath: "/ghq/Org/foo-oracle.wt-1-my-task",
      windowName: "foo-my-task",
    };

    await cmdWake("foo", { task: "My Task!" });

    expect(createWorktreeCalls).toHaveLength(1);
    expect(createWorktreeCalls[0].name).toBe("my-task"); // sanitizeBranchName lowercases/strips
    expect(createWorktreeCalls[0].oracle).toBe("foo");
  });

  test("--fresh skips resolveWorktreeTarget even when exact match exists", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [
      { path: "/ghq/Org/foo-oracle.wt-1-existing", name: "1-existing" },
    ];

    await cmdWake("foo", { task: "existing", fresh: true });
    expect(createWorktreeCalls).toHaveLength(1);
    expect(createWorktreeCalls[0].name).toBe("existing");
  });

  test("ambiguous match throws with candidate list", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [
      { path: "/ghq/Org/foo-oracle.wt-1-pay-v1", name: "1-pay-v1" },
      { path: "/ghq/Org/foo-oracle.wt-2-pay-v2", name: "2-pay-v2" },
    ];

    let caught: Error | null = null;
    try { await cmdWake("foo", { task: "pay" }); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("ambiguous");
    expect(caught!.message).toContain("1-pay-v1");
    expect(caught!.message).toContain("2-pay-v2");
  });

  test("--wt uses the same resolution path as --task", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    findWorktreesReturn = [];
    await cmdWake("foo", { wt: "newone" });
    expect(createWorktreeCalls).toHaveLength(1);
    expect(createWorktreeCalls[0].name).toBe("newone");
  });
});

// ─── 7. --prompt (escape single quotes) ────────────────────────────────────

describe("cmdWake — --prompt handling", () => {
  test("prompt sent with -p 'escaped' when creating fresh window", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    await cmdWake("foo", { prompt: "hello" });

    // Last sendText is the new main window with prompt
    const sends = tmuxOp("sendText");
    const last = sends[sends.length - 1];
    expect(last.args[1]).toContain("-p 'hello'");
  });

  test("single quotes in prompt → escaped via '\\'' shell trick", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [{ index: 0, name: "foo-oracle", active: true }];
    await cmdWake("foo", { prompt: "it's alive" });

    const sends = tmuxOp("sendText");
    const last = sends[sends.length - 1];
    expect(last.args[1]).toContain("'it'\\''s alive'");
  });

  test("existing window + prompt → selectWindow then sendText with -p", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [
      { index: 0, name: "foo-oracle", active: true },
    ];

    await cmdWake("foo", { prompt: "hi" });

    // Selected the pre-existing main window
    expect(tmuxOp("selectWindow").length).toBeGreaterThanOrEqual(1);
    const selects = tmuxOp("selectWindow");
    expect(selects[0].args[0]).toBe("foo:foo-oracle");
  });

  test("fresh window + prompt → newWindow, then sendText with -p 'escaped'", async () => {
    // detectSessionReturn = null → new session branch. listWindows on the
    // just-created session returns [] (our mock default), so the try-block
    // falls through to `tmux.newWindow(...)` + the prompt-aware sendText at
    // wake-cmd.ts:181-183.
    detectSessionReturn = null;
    await cmdWake("foo", { prompt: "hi 'you'" });

    // Final sendText carries the -p 'escaped' flag
    const sends = tmuxOp("sendText");
    const last = sends[sends.length - 1];
    expect(last.args[1]).toContain("-p 'hi '\\''you'\\'''");
  });
});

// ─── 8. --attach ────────────────────────────────────────────────────────────

describe("cmdWake — --attach", () => {
  test("fresh window + --attach → attachToSession called", async () => {
    await cmdWake("foo", { attach: true });
    expect(attachToSessionCalls).toEqual(["foo"]);
  });

  test("existing window + --attach → selectWindow then attach", async () => {
    detectSessionReturn = "foo";
    tmuxListWindowsByName["foo"] = [
      { index: 0, name: "foo-oracle", active: true },
    ];
    await cmdWake("foo", { attach: true });

    expect(attachToSessionCalls).toEqual(["foo"]);
    expect(tmuxOp("selectWindow").length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 9. --split ─────────────────────────────────────────────────────────────

describe("cmdWake — --split", () => {
  test("--split + TMUX env set → cmdSplit invoked with session:window", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,5";
    await cmdWake("foo", { split: true });
    expect(cmdSplitCalls).toHaveLength(1);
    expect(cmdSplitCalls[0]).toContain("foo:");
  });

  test("--split without TMUX env → cmdSplit NOT called (warning branch)", async () => {
    const warns: string[] = [];
    console.log = (...a) => { warns.push(a.map(String).join(" ")); };
    await cmdWake("foo", { split: true });

    expect(cmdSplitCalls).toHaveLength(0);
    // #539 P1: warning text now reads as a runbook. Both the server-up and
    // no-server branches share the "--split skipped" prefix.
    expect(warns.some(w => w.includes("--split skipped"))).toBe(true);
  });

  test("--split + TMUX + cmdSplit throws → error caught, flow continues to takeSnapshot", async () => {
    process.env.TMUX = "/tmp/tmux-test";
    cmdSplitThrow = new Error("pane died");
    await cmdWake("foo", { split: true });

    expect(cmdSplitCalls).toHaveLength(1);
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });
});

// ─── 10. End-of-flow: restoreTabOrder + takeSnapshot ────────────────────────

describe("cmdWake — tail effects", () => {
  test("restoreTabOrder called with session name", async () => {
    await cmdWake("foo", {});
    expect(restoreTabOrderCalls).toEqual(["foo"]);
  });

  test("takeSnapshot called with 'wake'", async () => {
    await cmdWake("foo", {});
    expect(takeSnapshotCalls).toEqual(["wake"]);
  });

  test("returns 'session:window' identifier", async () => {
    const ret = await cmdWake("foo", {});
    expect(ret).toBe("foo:foo-oracle");
  });
});

// ─── 11. Existing window NN-prefix sibling match ────────────────────────────

describe("cmdWake — existing window detection", () => {
  test("finds existing window by `${oracle}-\\d+-${name}` sibling pattern", async () => {
    detectSessionReturn = "foo";
    // The main foo-oracle plus a sibling worktree window named foo-1-alpha.
    tmuxListWindowsByName["foo"] = [
      { index: 0, name: "foo-oracle", active: true },
      { index: 1, name: "foo-1-alpha", active: false },
    ];
    findWorktreesReturn = [
      { path: "/ghq/Org/foo-oracle.wt-1-alpha", name: "1-alpha" },
    ];
    // --task "alpha" → sanitized = "alpha" → resolveWorktreeTarget finds 1-alpha
    // → reuses, windowName = "foo-alpha". Then sibling scan matches foo-1-alpha.
    await cmdWake("foo", { task: "alpha" });

    // Should NOT create a new "foo-alpha" window since foo-1-alpha matches the pattern.
    // NB: first newWindow is the respawn pass for "foo-1-alpha" already in existing
    // set — respawn loop SKIPS when altName already in existingWindows; but the
    // respawn branch is the "session exists" path. Our existing-windows set has
    // foo-1-alpha so we skip respawning, and the final newWindow guard recognizes
    // the sibling, so no final newWindow either.
    const newWins = tmuxOp("newWindow").map(c => c.args[1] as string);
    expect(newWins).not.toContain("foo-alpha");
  });
});
