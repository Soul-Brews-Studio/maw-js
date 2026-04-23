/**
 * soul-sync/impl.ts — cmdSoulSync + cmdSoulSyncProject.
 *
 *   cmdSoulSync: resolves cwd (opts.cwd → tmux → process.cwd), detects
 *     worktree via `git rev-parse --git-common-dir`, finds peers (target or
 *     fleet), loops per-peer, resolves peer oracle path, calls syncOracleVaults.
 *   cmdSoulSyncProject: branches on oracle-cwd vs project-cwd; iterates
 *     `project_repos` (oracle branch) or resolves slug → owning oracle →
 *     resolveOraclePath (project branch). Both call syncProjectVault.
 *
 * Isolated because we mock.module on four seams impl.ts walks through:
 *   - src/sdk                                         (hostExec barrel)
 *   - src/config                                      (loadConfig → ghqRoot)
 *   - src/commands/plugins/soul-sync/sync-helpers     (findPeers, sync*Vault, …)
 *   - src/commands/plugins/soul-sync/resolve          (resolveOraclePath, …)
 *
 * mock.module is process-global → every mock captures REAL fn refs before
 * installing and uses a `mockActive` gate so other isolated tests see real
 * behavior (see #375 pollution catalog: mock.module replaces the namespace
 * object, so `real.fn` after mocking points to our wrapper → infinite recursion
 * hang). Every passthrough wrapper uses `(...args)` rest-args; dropping optional
 * positional args broke split-cascade in alpha.77 — same rule applies here.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { mockSshModule } from "../helpers/mock-ssh";

// ─── Scratch tmpdir (used by cmdSoulSyncProject oracle-branch existsSync) ───

const tmpBase = mkdtempSync(join(tmpdir(), "maw-soul-sync-impl-"));

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rSdk = await import("../../src/sdk");
const realHostExec = _rSdk.hostExec;

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;

const _rSyncHelpers = await import("../../src/commands/plugins/soul-sync/sync-helpers");
const realFindPeers = _rSyncHelpers.findPeers;
const realFindProjectsForOracle = _rSyncHelpers.findProjectsForOracle;
const realSyncOracleVaults = _rSyncHelpers.syncOracleVaults;
const realSyncProjectVault = _rSyncHelpers.syncProjectVault;
const realReportProjectResult = _rSyncHelpers.reportProjectResult;
const realSyncDir = _rSyncHelpers.syncDir;

const _rGhqRoot = await import("../../src/config/ghq-root");
const realGetGhqRoot = _rGhqRoot.getGhqRoot;

const _rResolve = await import("../../src/commands/plugins/soul-sync/resolve");
const realResolveOraclePath = _rResolve.resolveOraclePath;
const realResolveProjectSlug = _rResolve.resolveProjectSlug;
const realFindOracleForProject = _rResolve.findOracleForProject;

// ─── Mutable state captured by mock wrappers ────────────────────────────────

let mockActive = false;

// hostExec
let hostExecCalls: string[] = [];
interface ExecResponse { match: RegExp; result?: string; error?: string; }
let hostExecResponses: ExecResponse[] = [];

// config
let configOverride = { ghqRoot: join(tmpBase, "ghq") };

// sync-helpers
let findPeersReturn: string[] = [];
let findPeersCalls: string[] = [];
let findProjectsReturn: string[] = [];
let findProjectsCalls: string[] = [];

interface SyncOracleCall {
  from: string; to: string; fromName: string; toName: string;
}
let syncOracleVaultsCalls: SyncOracleCall[] = [];
let syncOracleVaultsReturns: Array<{ from: string; to: string; synced: Record<string, number>; total: number }> = [];

interface SyncProjectCall {
  projectPath: string; oraclePath: string; projectRepo: string; oracleName: string;
}
let syncProjectVaultCalls: SyncProjectCall[] = [];
let syncProjectVaultReturn = { project: "", oracle: "", synced: {}, total: 0 };

let reportProjectResultCalls: Array<{ project: string; oracle: string; total: number }> = [];

// resolve
let resolveOraclePathMap: Record<string, string | null> = {};
let resolveOraclePathCalls: string[] = [];
let resolveProjectSlugReturn: string | null = null;
let findOracleForProjectReturn: string | null = null;

// ─── Mocks ──────────────────────────────────────────────────────────────────

// sdk barrel — passthrough-spread so other tests that pull anything out of
// sdk continue to see real exports.
mock.module(
  join(import.meta.dir, "../../src/sdk"),
  () => ({
    ..._rSdk,
    hostExec: async (...args: any[]) => {
      if (!mockActive) return (realHostExec as any)(...args);
      const cmd = args[0] as string;
      hostExecCalls.push(cmd);
      for (const r of hostExecResponses) {
        if (r.match.test(cmd)) {
          if (r.error) throw new Error(r.error);
          return r.result ?? "";
        }
      }
      return "";
    },
  }),
);

// ssh — defensive full-surface mock in case any transitive import pulls from
// ssh directly (soul-sync-resolve-oracle.test.ts also mocks this).
mock.module(
  join(import.meta.dir, "../../src/core/transport/ssh"),
  () => mockSshModule({
    hostExec: async (...args: any[]) => {
      if (!mockActive) return "";
      const cmd = args[0] as string;
      hostExecCalls.push(cmd);
      for (const r of hostExecResponses) {
        if (r.match.test(cmd)) {
          if (r.error) throw new Error(r.error);
          return r.result ?? "";
        }
      }
      return "";
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: (...args: any[]) =>
      mockActive ? configOverride : (realLoadConfig as any)(...args),
  }),
);

// #680 — getGhqRoot moved to leaf module config/ghq-root. soul-sync/impl.ts
// calls getGhqRoot() to resolve reposRoot, so the mock reads configOverride.ghqRoot.
mock.module(
  join(import.meta.dir, "../../src/config/ghq-root"),
  () => ({
    ..._rGhqRoot,
    getGhqRoot: () =>
      mockActive ? configOverride.ghqRoot : realGetGhqRoot(),
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/plugins/soul-sync/sync-helpers"),
  () => ({
    syncDir: (...args: any[]) => (realSyncDir as any)(...args),
    findPeers: (...args: any[]) => {
      if (!mockActive) return (realFindPeers as any)(...args);
      findPeersCalls.push(args[0] as string);
      return findPeersReturn;
    },
    findProjectsForOracle: (...args: any[]) => {
      if (!mockActive) return (realFindProjectsForOracle as any)(...args);
      findProjectsCalls.push(args[0] as string);
      return findProjectsReturn;
    },
    syncOracleVaults: (...args: any[]) => {
      if (!mockActive) return (realSyncOracleVaults as any)(...args);
      const [from, to, fromName, toName] = args as [string, string, string, string];
      syncOracleVaultsCalls.push({ from, to, fromName, toName });
      return syncOracleVaultsReturns.shift() ?? { from: fromName, to: toName, synced: {}, total: 0 };
    },
    syncProjectVault: (...args: any[]) => {
      if (!mockActive) return (realSyncProjectVault as any)(...args);
      const [projectPath, oraclePath, projectRepo, oracleName] = args as [string, string, string, string];
      syncProjectVaultCalls.push({ projectPath, oraclePath, projectRepo, oracleName });
      return { ...syncProjectVaultReturn, project: projectRepo, oracle: oracleName };
    },
    reportProjectResult: (...args: any[]) => {
      if (!mockActive) return (realReportProjectResult as any)(...args);
      const r = args[0] as { project: string; oracle: string; total: number };
      reportProjectResultCalls.push({ project: r.project, oracle: r.oracle, total: r.total });
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/commands/plugins/soul-sync/resolve"),
  () => ({
    resolveOraclePath: async (...args: any[]) => {
      if (!mockActive) return (realResolveOraclePath as any)(...args);
      const name = args[0] as string;
      resolveOraclePathCalls.push(name);
      return name in resolveOraclePathMap ? resolveOraclePathMap[name] : null;
    },
    resolveProjectSlug: (...args: any[]) => {
      if (!mockActive) return (realResolveProjectSlug as any)(...args);
      return resolveProjectSlugReturn;
    },
    findOracleForProject: (...args: any[]) => {
      if (!mockActive) return (realFindOracleForProject as any)(...args);
      return findOracleForProjectReturn;
    },
  }),
);

// NB: load impl AFTER all mock.module calls so its import graph resolves
// through our stubs (bun replaces the module registry at mock.module time).
const { cmdSoulSync, cmdSoulSyncProject } = await import(
  "../../src/commands/plugins/soul-sync/impl"
);

// ─── Test harness ───────────────────────────────────────────────────────────

const origLog = console.log;
const origCwd = process.cwd;

beforeEach(() => {
  console.log = () => {};
  mockActive = true;
  hostExecCalls = [];
  hostExecResponses = [];
  configOverride = { ghqRoot: join(tmpBase, "ghq") };
  findPeersReturn = [];
  findPeersCalls = [];
  findProjectsReturn = [];
  findProjectsCalls = [];
  syncOracleVaultsCalls = [];
  syncOracleVaultsReturns = [];
  syncProjectVaultCalls = [];
  syncProjectVaultReturn = { project: "", oracle: "", synced: {}, total: 0 };
  reportProjectResultCalls = [];
  resolveOraclePathMap = {};
  resolveOraclePathCalls = [];
  resolveProjectSlugReturn = null;
  findOracleForProjectReturn = null;
});

afterEach(() => {
  console.log = origLog;
  mockActive = false;
  process.cwd = origCwd;
});

afterAll(() => {
  console.log = origLog;
  mockActive = false;
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

// ─── cmdSoulSync — cwd resolution ────────────────────────────────────────────

describe("cmdSoulSync — cwd resolution", () => {
  test("opts.cwd given → tmux display-message NOT called", async () => {
    findPeersReturn = []; // no peers → early return, skips git rev-parse
    await cmdSoulSync(undefined, { cwd: "/home/me/Code/github.com/Org/foo-oracle" });
    expect(hostExecCalls.some(c => c.includes("tmux display-message"))).toBe(false);
  });

  test("opts.cwd empty → tmux display-message called + used as cwd", async () => {
    hostExecResponses = [
      { match: /tmux display-message/, result: "/from/tmux/bar-oracle" },
    ];
    findPeersReturn = [];
    await cmdSoulSync(undefined, {});
    expect(hostExecCalls.some(c => c.includes("tmux display-message"))).toBe(true);
    // oracleName derived from "bar-oracle" (tmux path, -oracle stripped) → findPeers("bar")
    expect(findPeersCalls).toEqual(["bar"]);
  });

  test("opts.cwd empty + tmux throws → process.cwd() fallback", async () => {
    hostExecResponses = [{ match: /tmux display-message/, error: "no tmux" }];
    findPeersReturn = [];
    // Force a deterministic process.cwd()
    process.cwd = () => "/fallback/path/baz-oracle";
    await cmdSoulSync(undefined, {});
    // oracleName from the fallback cwd
    expect(findPeersCalls).toEqual(["baz"]);
  });
});

// ─── cmdSoulSync — oracleName derivation ────────────────────────────────────

describe("cmdSoulSync — oracleName derivation from repo basename", () => {
  test("-oracle suffix stripped from repo basename", async () => {
    findPeersReturn = [];
    await cmdSoulSync(undefined, { cwd: "/a/b/neo-oracle" });
    expect(findPeersCalls).toEqual(["neo"]);
  });

  test(".wt-<name> worktree suffix stripped (regex order: -oracle$ first, then .wt-...)", async () => {
    findPeersReturn = [];
    await cmdSoulSync(undefined, { cwd: "/a/b/neo.wt-1-task" });
    // repoName = "neo.wt-1-task" → no -oracle suffix → strip .wt-... → "neo"
    expect(findPeersCalls).toEqual(["neo"]);
  });
});

// ─── cmdSoulSync — worktree detection via git rev-parse ─────────────────────

describe("cmdSoulSync — git rev-parse --git-common-dir handling", () => {
  test("common-dir absolute → oraclePath = join(commonDir, '..')", async () => {
    hostExecResponses = [
      { match: /git -C.*rev-parse --git-common-dir/, result: "/ghq/Org/foo-oracle/.git" },
    ];
    findPeersReturn = ["peer-a"];
    resolveOraclePathMap = { "peer-a": "/ghq/Org/peer-a-oracle" };
    syncOracleVaultsReturns = [{ from: "foo", to: "peer-a", synced: {}, total: 0 }];

    await cmdSoulSync(undefined, { cwd: "/ghq/Org/foo-oracle.wt-1-task" });

    // push direction → from = oraclePath = /ghq/Org/foo-oracle (parent of .git)
    expect(syncOracleVaultsCalls[0].from).toBe("/ghq/Org/foo-oracle");
  });

  test("common-dir relative → joined against cwd", async () => {
    hostExecResponses = [
      { match: /git -C.*rev-parse --git-common-dir/, result: "../../foo-oracle/.git" },
    ];
    findPeersReturn = ["peer-a"];
    resolveOraclePathMap = { "peer-a": "/ghq/Org/peer-a-oracle" };
    syncOracleVaultsReturns = [{ from: "x", to: "y", synced: {}, total: 0 }];

    await cmdSoulSync(undefined, { cwd: "/ghq/Org/foo-oracle.wt-1-task" });

    // join(cwd, commonDir) + ".." → /ghq/Org/foo-oracle
    expect(syncOracleVaultsCalls[0].from).toContain("foo-oracle");
  });

  test("common-dir returns literal '.git' → oraclePath stays as cwd", async () => {
    hostExecResponses = [
      { match: /git -C.*rev-parse --git-common-dir/, result: ".git" },
    ];
    findPeersReturn = ["peer-a"];
    resolveOraclePathMap = { "peer-a": "/ghq/Org/peer-a-oracle" };
    syncOracleVaultsReturns = [{ from: "x", to: "y", synced: {}, total: 0 }];

    await cmdSoulSync(undefined, { cwd: "/ghq/Org/foo-oracle" });

    expect(syncOracleVaultsCalls[0].from).toBe("/ghq/Org/foo-oracle");
  });

  test("git rev-parse throws → oraclePath stays as cwd (swallowed)", async () => {
    hostExecResponses = [
      { match: /git -C.*rev-parse/, error: "not a git repo" },
    ];
    findPeersReturn = ["peer-a"];
    resolveOraclePathMap = { "peer-a": "/ghq/Org/peer-a-oracle" };
    syncOracleVaultsReturns = [{ from: "x", to: "y", synced: {}, total: 0 }];

    await cmdSoulSync(undefined, { cwd: "/plain/dir/foo-oracle" });

    expect(syncOracleVaultsCalls[0].from).toBe("/plain/dir/foo-oracle");
  });
});

// ─── cmdSoulSync — peer resolution ──────────────────────────────────────────

describe("cmdSoulSync — peer resolution", () => {
  test("target given → single-peer list, findPeers NOT consulted", async () => {
    resolveOraclePathMap = { explicit: "/ghq/Org/explicit-oracle" };
    syncOracleVaultsReturns = [{ from: "foo", to: "explicit", synced: {}, total: 0 }];
    const results = await cmdSoulSync("explicit", { cwd: "/a/foo-oracle" });

    expect(findPeersCalls).toEqual([]);
    expect(resolveOraclePathCalls).toEqual(["explicit"]);
    expect(results).toHaveLength(1);
  });

  test("no target + findPeers returns [] → warning + empty results", async () => {
    findPeersReturn = [];
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSync(undefined, { cwd: "/a/foo-oracle" });

    expect(results).toEqual([]);
    expect(warns.some(w => w.includes("no sync_peers configured"))).toBe(true);
    expect(warns.some(w => w.includes("'foo'"))).toBe(true);
    // Never reached resolveOraclePath / syncOracleVaults
    expect(resolveOraclePathCalls).toEqual([]);
    expect(syncOracleVaultsCalls).toEqual([]);
  });

  test("no target + findPeers returns list → loops all peers", async () => {
    findPeersReturn = ["p1", "p2", "p3"];
    resolveOraclePathMap = {
      p1: "/ghq/Org/p1-oracle",
      p2: "/ghq/Org/p2-oracle",
      p3: "/ghq/Org/p3-oracle",
    };
    syncOracleVaultsReturns = [
      { from: "foo", to: "p1", synced: {}, total: 0 },
      { from: "foo", to: "p2", synced: {}, total: 0 },
      { from: "foo", to: "p3", synced: {}, total: 0 },
    ];

    const results = await cmdSoulSync(undefined, { cwd: "/a/foo-oracle" });

    expect(resolveOraclePathCalls).toEqual(["p1", "p2", "p3"]);
    expect(syncOracleVaultsCalls).toHaveLength(3);
    expect(results).toHaveLength(3);
  });
});

// ─── cmdSoulSync — direction (push / pull) ──────────────────────────────────

describe("cmdSoulSync — push vs pull direction", () => {
  test("no --from (default push) → syncOracleVaults(oraclePath, peerPath, oracle, peer)", async () => {
    resolveOraclePathMap = { peer1: "/ghq/Org/peer1-oracle" };
    syncOracleVaultsReturns = [{ from: "foo", to: "peer1", synced: {}, total: 0 }];

    await cmdSoulSync("peer1", { cwd: "/ghq/Org/foo-oracle" });

    const c = syncOracleVaultsCalls[0];
    expect(c.from).toBe("/ghq/Org/foo-oracle");
    expect(c.to).toBe("/ghq/Org/peer1-oracle");
    expect(c.fromName).toBe("foo");
    expect(c.toName).toBe("peer1");
  });

  test("--from (pull) → swaps: syncOracleVaults(peerPath, oraclePath, peer, oracle)", async () => {
    resolveOraclePathMap = { peer1: "/ghq/Org/peer1-oracle" };
    syncOracleVaultsReturns = [{ from: "peer1", to: "foo", synced: {}, total: 0 }];

    await cmdSoulSync("peer1", { cwd: "/ghq/Org/foo-oracle", from: true });

    const c = syncOracleVaultsCalls[0];
    expect(c.from).toBe("/ghq/Org/peer1-oracle");
    expect(c.to).toBe("/ghq/Org/foo-oracle");
    expect(c.fromName).toBe("peer1");
    expect(c.toName).toBe("foo");
  });

  test("pull label logged with arrow from peer → oracle", async () => {
    resolveOraclePathMap = { peer1: "/ghq/Org/peer1-oracle" };
    syncOracleVaultsReturns = [{ from: "peer1", to: "foo", synced: {}, total: 0 }];
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };

    await cmdSoulSync("peer1", { cwd: "/ghq/Org/foo-oracle", from: true });

    expect(logs.some(l => l.includes("pulling") && l.includes("peer1") && l.includes("foo"))).toBe(true);
  });
});

// ─── cmdSoulSync — per-peer loop ────────────────────────────────────────────

describe("cmdSoulSync — per-peer handling", () => {
  test("resolveOraclePath returns null → peer skipped, warning logged", async () => {
    findPeersReturn = ["missing"];
    resolveOraclePathMap = { missing: null };
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSync(undefined, { cwd: "/a/foo-oracle" });

    expect(warns.some(w => w.includes("missing") && w.includes("repo not found"))).toBe(true);
    expect(syncOracleVaultsCalls).toEqual([]);
    expect(results).toEqual([]);
  });

  test("total === 0 → 'nothing new' per-peer line", async () => {
    findPeersReturn = ["p1"];
    resolveOraclePathMap = { p1: "/ghq/Org/p1-oracle" };
    syncOracleVaultsReturns = [{ from: "foo", to: "p1", synced: {}, total: 0 }];
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };

    await cmdSoulSync(undefined, { cwd: "/a/foo-oracle" });

    expect(logs.some(l => l.includes("nothing new"))).toBe(true);
  });

  test("total > 0 → per-dir counts rendered + grand total line", async () => {
    findPeersReturn = ["p1"];
    resolveOraclePathMap = { p1: "/ghq/Org/p1-oracle" };
    syncOracleVaultsReturns = [{
      from: "foo", to: "p1",
      synced: { "memory/learnings": 3, "memory/retrospectives": 2 },
      total: 5,
    }];
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };

    await cmdSoulSync(undefined, { cwd: "/a/foo-oracle" });

    expect(logs.some(l => l.includes("3 learnings"))).toBe(true);
    expect(logs.some(l => l.includes("2 retrospectives"))).toBe(true);
    expect(logs.some(l => l.includes("5 file(s) synced"))).toBe(true);
  });

  test("mix of skipped + synced peers → results array only includes non-skipped", async () => {
    findPeersReturn = ["good", "bad", "also-good"];
    resolveOraclePathMap = {
      good: "/ghq/Org/good-oracle",
      bad: null,
      "also-good": "/ghq/Org/also-good-oracle",
    };
    syncOracleVaultsReturns = [
      { from: "foo", to: "good", synced: { "memory/learnings": 1 }, total: 1 },
      { from: "foo", to: "also-good", synced: {}, total: 0 },
    ];

    const results = await cmdSoulSync(undefined, { cwd: "/a/foo-oracle" });

    expect(results).toHaveLength(2);
    expect(results.map(r => r.to)).toEqual(["good", "also-good"]);
  });
});

// ─── cmdSoulSyncProject — oracle-cwd branch ─────────────────────────────────

describe("cmdSoulSyncProject — oracle-cwd branch", () => {
  test("oracle cwd + no project_repos → warning, empty results", async () => {
    findProjectsReturn = [];
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSyncProject({ cwd: "/a/b/foo-oracle" });

    expect(results).toEqual([]);
    expect(warns.some(w => w.includes("no project_repos configured"))).toBe(true);
    expect(syncProjectVaultCalls).toEqual([]);
  });

  test("oracle cwd + project missing on disk → skip with warning", async () => {
    findProjectsReturn = ["theorg/absent"];
    // Do NOT create the project dir under configOverride.ghqRoot
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSyncProject({ cwd: "/a/b/foo-oracle" });

    expect(syncProjectVaultCalls).toEqual([]);
    expect(results).toEqual([]);
    expect(warns.some(w => w.includes("theorg/absent") && w.includes("not found"))).toBe(true);
  });

  test("oracle cwd + project exists → syncProjectVault called (project→oracle)", async () => {
    // Materialize ghqRoot/github.com/theorg/present so existsSync passes.
    // #680 — getGhqRoot() returns the BARE root; impl appends "github.com".
    const ghqRoot = mkdtempSync(join(tmpBase, "ghq-"));
    configOverride = { ghqRoot };
    const projectPath = join(ghqRoot, "github.com", "theorg", "present");
    mkdirSync(projectPath, { recursive: true });
    findProjectsReturn = ["theorg/present"];
    syncProjectVaultReturn = {
      project: "theorg/present", oracle: "foo",
      synced: { "memory/learnings": 2 }, total: 2,
    };

    const results = await cmdSoulSyncProject({ cwd: "/a/b/foo-oracle" });

    expect(syncProjectVaultCalls).toHaveLength(1);
    expect(syncProjectVaultCalls[0].projectPath).toBe(projectPath);
    expect(syncProjectVaultCalls[0].oraclePath).toBe("/a/b/foo-oracle");
    expect(syncProjectVaultCalls[0].projectRepo).toBe("theorg/present");
    expect(syncProjectVaultCalls[0].oracleName).toBe("foo");
    expect(reportProjectResultCalls).toHaveLength(1);
    expect(reportProjectResultCalls[0].total).toBe(2);
    expect(results).toHaveLength(1);
  });

  test("oracle cwd + multiple projects (mix of present/absent) → only present sync'd", async () => {
    const ghqRoot = mkdtempSync(join(tmpBase, "ghq-"));
    configOverride = { ghqRoot };
    // #680 — getGhqRoot() returns bare root; impl appends "github.com".
    mkdirSync(join(ghqRoot, "github.com", "a", "present"), { recursive: true });
    findProjectsReturn = ["a/present", "b/absent"];

    await cmdSoulSyncProject({ cwd: "/a/b/foo-oracle" });

    expect(syncProjectVaultCalls).toHaveLength(1);
    expect(syncProjectVaultCalls[0].projectRepo).toBe("a/present");
  });

  test("oracle cwd + totalAll > 0 → 'absorbed' summary line", async () => {
    const ghqRoot = mkdtempSync(join(tmpBase, "ghq-"));
    configOverride = { ghqRoot };
    // #680 — getGhqRoot() returns bare root; impl appends "github.com".
    mkdirSync(join(ghqRoot, "github.com", "x", "y"), { recursive: true });
    findProjectsReturn = ["x/y"];
    syncProjectVaultReturn = { project: "x/y", oracle: "foo", synced: {}, total: 4 };
    const logs: string[] = [];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };

    await cmdSoulSyncProject({ cwd: "/a/b/foo-oracle" });

    expect(logs.some(l => l.includes("4 file(s) absorbed"))).toBe(true);
  });
});

// ─── cmdSoulSyncProject — project-cwd branch ────────────────────────────────

describe("cmdSoulSyncProject — project-cwd branch", () => {
  test("project cwd (not -oracle) + slug unresolvable → warning, empty results", async () => {
    resolveProjectSlugReturn = null;
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSyncProject({ cwd: "/not/ghq/random-repo" });

    expect(results).toEqual([]);
    expect(warns.some(w => w.includes("cannot resolve project slug"))).toBe(true);
    expect(syncProjectVaultCalls).toEqual([]);
  });

  test("project cwd + slug resolves but no oracle owns it → warning", async () => {
    resolveProjectSlugReturn = "theorg/lonely";
    findOracleForProjectReturn = null;
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSyncProject({ cwd: "/ghq/theorg/lonely" });

    expect(results).toEqual([]);
    expect(warns.some(w => w.includes("no oracle owns project 'theorg/lonely'"))).toBe(true);
  });

  test("project cwd + oracle found but oracle repo not found locally → warning", async () => {
    resolveProjectSlugReturn = "theorg/proj";
    findOracleForProjectReturn = "missingoracle";
    resolveOraclePathMap = { missingoracle: null };
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    const results = await cmdSoulSyncProject({ cwd: "/ghq/theorg/proj" });

    expect(results).toEqual([]);
    expect(warns.some(w => w.includes("oracle 'missingoracle' repo not found"))).toBe(true);
    expect(syncProjectVaultCalls).toEqual([]);
  });

  test("project cwd + full happy path → syncProjectVault called with project→oracle args", async () => {
    resolveProjectSlugReturn = "theorg/proj";
    findOracleForProjectReturn = "owneroracle";
    resolveOraclePathMap = { owneroracle: "/ghq/Org/owneroracle-oracle" };
    syncProjectVaultReturn = {
      project: "theorg/proj", oracle: "owneroracle",
      synced: { "memory/traces": 1 }, total: 1,
    };

    const results = await cmdSoulSyncProject({ cwd: "/ghq/theorg/proj" });

    expect(syncProjectVaultCalls).toHaveLength(1);
    const c = syncProjectVaultCalls[0];
    // projectPath = git rev-parse --show-toplevel result OR cwd fallback
    expect(c.oraclePath).toBe("/ghq/Org/owneroracle-oracle");
    expect(c.projectRepo).toBe("theorg/proj");
    expect(c.oracleName).toBe("owneroracle");
    expect(reportProjectResultCalls).toHaveLength(1);
    expect(results).toHaveLength(1);
  });

  test("project cwd + git show-toplevel succeeds → repoRoot uses that path", async () => {
    hostExecResponses = [
      { match: /git -C.*rev-parse --show-toplevel/, result: "/canonical/repo/root" },
    ];
    resolveProjectSlugReturn = "theorg/proj";
    findOracleForProjectReturn = "owneroracle";
    resolveOraclePathMap = { owneroracle: "/ghq/Org/owneroracle-oracle" };

    await cmdSoulSyncProject({ cwd: "/some/wt/dir" });

    // projectPath in syncProjectVault comes from git show-toplevel output
    expect(syncProjectVaultCalls[0].projectPath).toBe("/canonical/repo/root");
  });

  test("project cwd + git show-toplevel throws → repoRoot falls back to cwd", async () => {
    hostExecResponses = [{ match: /git -C.*rev-parse/, error: "not a git repo" }];
    resolveProjectSlugReturn = "theorg/proj";
    findOracleForProjectReturn = "owneroracle";
    resolveOraclePathMap = { owneroracle: "/ghq/Org/owneroracle-oracle" };

    await cmdSoulSyncProject({ cwd: "/raw/cwd/path" });

    expect(syncProjectVaultCalls[0].projectPath).toBe("/raw/cwd/path");
  });
});

// ─── cmdSoulSyncProject — cwd resolution ────────────────────────────────────

describe("cmdSoulSyncProject — cwd resolution", () => {
  test("opts.cwd empty → tmux display-message called", async () => {
    hostExecResponses = [
      { match: /tmux display-message/, result: "/tmux/path/foo-oracle" },
    ];
    findProjectsReturn = [];
    await cmdSoulSyncProject({});
    expect(hostExecCalls.some(c => c.includes("tmux display-message"))).toBe(true);
  });

  test("opts.cwd empty + tmux throws → process.cwd() fallback, project branch triggered", async () => {
    hostExecResponses = [
      { match: /tmux display-message/, error: "no tmux" },
      { match: /rev-parse --show-toplevel/, error: "no git" },
    ];
    process.cwd = () => "/fallback/plain-repo"; // not ending in -oracle → project branch
    resolveProjectSlugReturn = null;
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

    await cmdSoulSyncProject();

    expect(warns.some(w => w.includes("cannot resolve project slug"))).toBe(true);
  });
});
