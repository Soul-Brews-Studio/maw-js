/**
 * bud-wake.ts — finalizeBud() covers steps 5-8.5 of `maw bud`:
 *   5. soul-sync seed (opt-in) or born-blank hint
 *   6. initial git commit + push
 *   7. parent sync_peers update
 *   8. wake the bud (with --issue / --repo variants)
 *   8.25. optional --split pane
 *   8.5. copy local project ψ/ when --repo used
 *
 * Isolated because we mock.module() on six modules bud-wake.ts pulls in:
 *   - src/core/transport/ssh         (hostExec) — via mockSshModule helper
 *   - src/commands/shared/fleet-load (loadFleetEntries)
 *   - src/commands/shared/wake       (cmdWake + fetchIssuePrompt)
 *   - src/commands/shared/wake-target (ensureCloned)
 *   - src/commands/plugins/soul-sync/impl (cmdSoulSync + syncDir)
 *   - src/commands/plugins/split/impl (cmdSplit)
 *
 * mock.module is process-global → every mock declares the FULL set of runtime
 * exports for its target module, stubbed by default (see #375 for the
 * "mock pollution" incident this pattern exists to prevent). Tests override
 * only the fields they care about.
 *
 * FLEET_DIR is intentionally NOT mocked — bud-init.test.ts mocks src/core/paths
 * and a second mock of the same path would race (last-wins is process-global).
 * Instead we compute entry.file with `path.relative(FLEET_DIR, myAbsFile)` so
 * `join(FLEET_DIR, entry.file)` resolves back to our test file regardless of
 * what FLEET_DIR currently points to.
 *
 * Strategy:
 *   - hostExec stubbed with programmable responses; assert on captured cmd strings.
 *   - cmdWake/cmdSoulSync/cmdSplit/syncDir/ensureCloned/fetchIssuePrompt all log
 *     their call args into arrays; tests assert on exact values (observable
 *     effects, not spy counts).
 *   - Real fs on mkdtempSync tmpdirs for budRepoPath, psiDir, ghqRoot, test fleet
 *     files. afterAll cleans up the scratch root.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync,
} from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { mockSshModule } from "../helpers/mock-ssh";

// ─── Scratch tmpdir ─────────────────────────────────────────────────────────

const tmpBase = mkdtempSync(join(tmpdir(), "maw-bud-wake-"));

// ─── Import real modules BEFORE mocking so we can delegate passthrough.
// Bun loads ALL test-file top-levels before running any tests, so our mocks
// would otherwise be active during OTHER test files' tests. Wrapping each
// mock around the real module's exports keeps bud-init/soul-sync/split-cascade
// tests seeing real behavior by default — our overrides activate only when
// our per-test state variables are set.

// Capture direct function REFERENCES (not the namespace) before mocks register.
// Rationale: bun's mock.module replaces the namespace object, so
// `realFleetLoad.loadFleetEntries` after mocking points to OUR wrapper →
// infinite recursion hang. Binding the function here preserves the original.
const _rFleetLoad = await import("../../src/commands/shared/fleet-load");
const realLoadFleetEntries = _rFleetLoad.loadFleetEntries;
const _rSoulSyncImpl = await import("../../src/commands/plugins/soul-sync/impl");
const realCmdSoulSync = _rSoulSyncImpl.cmdSoulSync;
const realSyncDir = _rSoulSyncImpl.syncDir;
const realResolveOraclePath = _rSoulSyncImpl.resolveOraclePath;
const realResolveProjectSlug = _rSoulSyncImpl.resolveProjectSlug;
const realFindOracleForProject = _rSoulSyncImpl.findOracleForProject;
const realFindPeers = _rSoulSyncImpl.findPeers;
const realFindProjectsForOracle = _rSoulSyncImpl.findProjectsForOracle;
const realSyncProjectVault = _rSoulSyncImpl.syncProjectVault;
const realCmdSoulSyncProject = _rSoulSyncImpl.cmdSoulSyncProject;
const _rWake = await import("../../src/commands/shared/wake");
const realCmdWake = _rWake.cmdWake;
const realFetchIssuePrompt = _rWake.fetchIssuePrompt;
const realFetchGitHubPrompt = _rWake.fetchGitHubPrompt;
const realIsPaneIdle = _rWake.isPaneIdle;
const realEnsureSessionRunning = _rWake.ensureSessionRunning;
const realFindWorktrees = _rWake.findWorktrees;
const realDetectSession = _rWake.detectSession;
const realResolveFleetSession = _rWake.resolveFleetSession;
const _rWakeTarget = await import("../../src/commands/shared/wake-target");
const realEnsureCloned = _rWakeTarget.ensureCloned;
const _rSplitImpl = await import("../../src/commands/plugins/split/impl");
const realCmdSplit = _rSplitImpl.cmdSplit;
const _rGhqRoot = await import("../../src/config/ghq-root");
const realGetGhqRoot = _rGhqRoot.getGhqRoot;

// ─── Mocks (registered BEFORE importing bud-wake) ───────────────────────────

let mockActive = false; // true only while one of our tests is running

let hostExecCalls: string[] = [];
let hostExecResponses: Array<{ match: RegExp; error?: string; result?: string }> = [];
const mockHostExec = async (cmd: string): Promise<string> => {
  hostExecCalls.push(cmd);
  for (const r of hostExecResponses) {
    if (r.match.test(cmd)) {
      if (r.error) throw new Error(r.error);
      return r.result ?? "";
    }
  }
  return "";
};

// ssh.ts — canonical defensive mock. Other isolated tests that care about
// hostExec use mockSshModule themselves (see split-cascade, peers-send) and
// re-register after us; for those that don't, the stubs here are safe no-ops.
mock.module(
  join(import.meta.dir, "../../src/core/transport/ssh"),
  () => mockSshModule({ hostExec: mockHostExec }),
);

interface MockFleetEntry {
  file: string;
  num: number;
  groupName: string;
  session: { name: string; windows: unknown[]; sync_peers?: string[] };
}

// Per-test override; null means "delegate to real impl" (passthrough).
let fleetEntriesOverride: MockFleetEntry[] | null = null;
mock.module(
  join(import.meta.dir, "../../src/commands/shared/fleet-load"),
  () => ({
    loadFleet: _rFleetLoad.loadFleet,
    getSessionNames: _rFleetLoad.getSessionNames,
    loadFleetEntries: () =>
      mockActive && fleetEntriesOverride !== null
        ? fleetEntriesOverride
        : realLoadFleetEntries(),
  }),
);

let cmdWakeCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
let cmdWakeThrow: Error | null = null;
let fetchIssuePromptCalls: Array<{ issue: number; repo: string }> = [];
let fetchIssuePromptReturn = "issue-body";
mock.module(
  join(import.meta.dir, "../../src/commands/shared/wake"),
  () => ({
    isPaneIdle: realIsPaneIdle,
    ensureSessionRunning: realEnsureSessionRunning,
    fetchGitHubPrompt: realFetchGitHubPrompt,
    findWorktrees: realFindWorktrees,
    detectSession: realDetectSession,
    resolveFleetSession: realResolveFleetSession,
    cmdWake: async (name: string, opts: Record<string, unknown>) => {
      if (!mockActive) return realCmdWake(name, opts as any);
      cmdWakeCalls.push({ name, opts });
      if (cmdWakeThrow) throw cmdWakeThrow;
      return "" as any;
    },
    fetchIssuePrompt: async (issue: number, repo: string) => {
      if (!mockActive) return realFetchIssuePrompt(issue, repo);
      fetchIssuePromptCalls.push({ issue, repo });
      return fetchIssuePromptReturn;
    },
  }),
);

let ensureClonedCalls: string[] = [];
mock.module(
  join(import.meta.dir, "../../src/commands/shared/wake-target"),
  () => ({
    ..._rWakeTarget,
    ensureCloned: async (repo: string) => {
      if (!mockActive) return realEnsureCloned(repo);
      ensureClonedCalls.push(repo);
    },
  }),
);

let cmdSoulSyncCalls: Array<{ target: string; opts: Record<string, unknown> }> = [];
let cmdSoulSyncThrow: Error | null = null;
let syncDirCalls: Array<{ src: string; dst: string }> = [];
mock.module(
  join(import.meta.dir, "../../src/commands/plugins/soul-sync/impl"),
  () => ({
    resolveOraclePath: realResolveOraclePath,
    resolveProjectSlug: realResolveProjectSlug,
    findOracleForProject: realFindOracleForProject,
    findPeers: realFindPeers,
    findProjectsForOracle: realFindProjectsForOracle,
    syncProjectVault: realSyncProjectVault,
    cmdSoulSyncProject: realCmdSoulSyncProject,
    cmdSoulSync: async (target?: string, opts?: Record<string, unknown>) => {
      if (!mockActive) return realCmdSoulSync(target, opts as any);
      cmdSoulSyncCalls.push({ target: target ?? "", opts: opts ?? {} });
      if (cmdSoulSyncThrow) throw cmdSoulSyncThrow;
      return [];
    },
    syncDir: (src: string, dst: string) => {
      if (!mockActive) return realSyncDir(src, dst);
      syncDirCalls.push({ src, dst });
    },
  }),
);

let cmdSplitCalls: string[] = [];
let cmdSplitThrow: Error | null = null;
mock.module(
  join(import.meta.dir, "../../src/commands/plugins/split/impl"),
  () => ({
    ..._rSplitImpl,
    cmdSplit: async (name: string, opts?: Record<string, unknown>) => {
      if (!mockActive) return realCmdSplit(name, opts as any);
      cmdSplitCalls.push(name);
      if (cmdSplitThrow) throw cmdSplitThrow;
    },
  }),
);

// #680 — getGhqRoot moved to leaf module config/ghq-root. finalizeBud calls
// getGhqRoot() to resolve reposRoot, so the mock must return the per-test
// ghqRoot from makeCtx.
let ghqRootOverride: string | null = null;
mock.module(
  join(import.meta.dir, "../../src/config/ghq-root"),
  () => ({
    ..._rGhqRoot,
    getGhqRoot: () => {
      if (mockActive && ghqRootOverride !== null) return ghqRootOverride;
      return realGetGhqRoot();
    },
    resetGhqRootCache: _rGhqRoot.resetGhqRootCache,
  }),
);

const { finalizeBud } = await import("../../src/commands/plugins/bud/bud-wake");
import type { BudFinalizeCtx } from "../../src/commands/plugins/bud/bud-wake";

// Snapshot the real FLEET_DIR at test-load time. Used by path.relative to build
// entry.file strings that `join(FLEET_DIR, entry.file)` resolves back to our
// absolute test files regardless of any downstream FLEET_DIR mock.
const { FLEET_DIR: FLEET_DIR_SNAP } = await import("../../src/sdk");

// ─── Test harness ───────────────────────────────────────────────────────────

afterAll(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

const origLog = console.log;
const origTmux = process.env.TMUX;
beforeEach(() => {
  console.log = () => {};
  mockActive = true; // turn on ALL our mock wrappers
  hostExecCalls = [];
  hostExecResponses = [];
  fleetEntriesOverride = null;
  cmdWakeCalls = [];
  cmdWakeThrow = null;
  fetchIssuePromptCalls = [];
  fetchIssuePromptReturn = "issue-body";
  ensureClonedCalls = [];
  cmdSoulSyncCalls = [];
  cmdSoulSyncThrow = null;
  syncDirCalls = [];
  cmdSplitCalls = [];
  cmdSplitThrow = null;
  ghqRootOverride = null;
  delete process.env.TMUX;
});
afterEach(() => {
  console.log = origLog;
  mockActive = false; // passthrough for other test files
  fleetEntriesOverride = null;
  if (origTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = origTmux;
});
afterAll(() => { console.log = origLog; mockActive = false; fleetEntriesOverride = null; });

// ─── Fixture builders ───────────────────────────────────────────────────────

function makeCtx(overrides: Partial<BudFinalizeCtx & { ghqRoot?: string }> = {}): BudFinalizeCtx {
  const budRepoPath = mkdtempSync(join(tmpBase, "bud-"));
  const psiDir = join(budRepoPath, "ψ");
  mkdirSync(join(psiDir, "memory"), { recursive: true });
  const ghqRoot = overrides.ghqRoot ?? mkdtempSync(join(tmpBase, "ghq-"));
  // #680 — finalizeBud calls getGhqRoot() instead of reading ctx.ghqRoot,
  // so we wire the per-test value into the mock override.
  ghqRootOverride = ghqRoot;
  const { ghqRoot: _discard, ...rest } = overrides;
  return {
    name: "newbud",
    parentName: "neo",
    org: "Soul-Brews-Studio",
    budRepoName: "newbud-oracle",
    budRepoPath,
    psiDir,
    fleetFile: join(tmpBase, "99-newbud.json"),
    opts: {},
    ...rest,
  };
}

/**
 * Write a fleet JSON file to our scratch tmpdir and build an entry whose
 * `.file` is a path that resolves back to our file when joined with FLEET_DIR.
 */
function seedFleetFile(num: number, stem: string, body: Record<string, unknown>): { entry: MockFleetEntry; path: string } {
  const seedDir = mkdtempSync(join(tmpBase, "fleet-"));
  const fileName = `${String(num).padStart(2, "0")}-${stem}.json`;
  const path = join(seedDir, fileName);
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return {
    entry: {
      file: relative(FLEET_DIR_SNAP, path),
      num,
      groupName: stem,
      session: body as MockFleetEntry["session"],
    },
    path,
  };
}

// ─── Step 5: soul-sync seed / born-blank ────────────────────────────────────

describe("finalizeBud — step 5 (soul-sync seed)", () => {
  test("--seed with parent → calls cmdSoulSync(parent, { from: true, cwd: budRepoPath })", async () => {
    const ctx = makeCtx({ parentName: "neo", opts: { seed: true } });
    await finalizeBud(ctx);

    expect(cmdSoulSyncCalls).toHaveLength(1);
    expect(cmdSoulSyncCalls[0].target).toBe("neo");
    expect(cmdSoulSyncCalls[0].opts).toEqual({ from: true, cwd: ctx.budRepoPath });
  });

  test("--seed with parent, cmdSoulSync throws → swallowed, flow continues to git commit", async () => {
    cmdSoulSyncThrow = new Error("parent has empty ψ/");
    const ctx = makeCtx({ parentName: "neo", opts: { seed: true } });
    await finalizeBud(ctx);

    expect(cmdSoulSyncCalls).toHaveLength(1);
    expect(hostExecCalls.some((c) => c.includes("git -C") && c.includes("add -A"))).toBe(true);
  });

  test("parentName without --seed → no cmdSoulSync call (born-blank branch)", async () => {
    const ctx = makeCtx({ parentName: "neo", opts: {} });
    await finalizeBud(ctx);

    expect(cmdSoulSyncCalls).toHaveLength(0);
  });

  test("no parentName → no cmdSoulSync call even with --seed (root oracle branch)", async () => {
    const ctx = makeCtx({ parentName: null, opts: { seed: true } });
    await finalizeBud(ctx);

    // Even with --seed, a root oracle has no parent to pull from.
    expect(cmdSoulSyncCalls).toHaveLength(0);
  });
});

// ─── Step 6: git commit + push ──────────────────────────────────────────────

describe("finalizeBud — step 6 (git commit + push)", () => {
  test("runs `git add -A`, `git commit`, `git push -u origin HEAD` in order w/ parent message", async () => {
    const ctx = makeCtx({ parentName: "neo", opts: {} });
    await finalizeBud(ctx);

    const gits = hostExecCalls.filter((c) => c.startsWith("git -C"));
    const addIdx = gits.findIndex((c) => c.includes(" add -A"));
    const commitIdx = gits.findIndex((c) => c.includes(" commit "));
    const pushIdx = gits.findIndex((c) => c.includes(" push -u origin HEAD"));

    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);

    expect(gits[commitIdx]).toContain("feat: birth — budded from neo");
    expect(gits[commitIdx]).toContain(`git -C '${ctx.budRepoPath}'`);
  });

  test("root oracle → commit message says 'root oracle' (no 'budded from')", async () => {
    const ctx = makeCtx({ parentName: null, opts: {} });
    await finalizeBud(ctx);

    const commit = hostExecCalls.find((c) => c.includes(" commit "));
    expect(commit).toBeDefined();
    expect(commit).toContain("feat: birth — root oracle");
    expect(commit).not.toContain("budded from");
  });

  test("git command throws → swallowed, finalizeBud still proceeds to wake", async () => {
    hostExecResponses = [
      { match: /git -C .* add -A/, error: "not a git repo" },
    ];
    const ctx = makeCtx({ parentName: null, opts: {} });
    await finalizeBud(ctx);

    expect(cmdWakeCalls).toHaveLength(1);
  });
});

// ─── Step 7: sync_peers update ──────────────────────────────────────────────

describe("finalizeBud — step 7 (parent sync_peers)", () => {
  test("matching parent entry without bud in peers → appends bud name + writes file", async () => {
    const { entry, path } = seedFleetFile(5, "neo", {
      name: "05-neo",
      windows: [{ name: "neo-oracle", repo: "Soul-Brews-Studio/neo-oracle" }],
      sync_peers: ["mawjs", "colab"],
    });
    fleetEntriesOverride = [entry];

    const ctx = makeCtx({ name: "newbud", parentName: "neo" });
    await finalizeBud(ctx);

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.sync_peers).toEqual(["mawjs", "colab", "newbud"]);
    expect(after.name).toBe("05-neo");
    expect(after.windows).toEqual([{ name: "neo-oracle", repo: "Soul-Brews-Studio/neo-oracle" }]);
  });

  test("strips NN- prefix off session.name when matching parent (42-neo matches stem 'neo')", async () => {
    const { entry, path } = seedFleetFile(42, "neo-prefix", {
      name: "42-neo",
      windows: [],
      sync_peers: [],
    });
    fleetEntriesOverride = [entry];

    const ctx = makeCtx({ name: "childA", parentName: "neo" });
    await finalizeBud(ctx);

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.sync_peers).toEqual(["childA"]);
  });

  test("matching parent entry where bud already in peers → no rewrite (byte-identical file)", async () => {
    const { entry, path } = seedFleetFile(6, "neo-already", {
      name: "06-neo",
      windows: [],
      sync_peers: ["alreadyhere"],
    });
    const before = readFileSync(path, "utf-8");
    fleetEntriesOverride = [entry];

    const ctx = makeCtx({ name: "alreadyhere", parentName: "neo" });
    await finalizeBud(ctx);

    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("parent entry without sync_peers field → initializes from [] and pushes bud", async () => {
    const { entry, path } = seedFleetFile(7, "neo-nopeers", {
      name: "07-neo",
      windows: [],
      // No sync_peers key — code falls back to `|| []`.
    });
    fleetEntriesOverride = [entry];

    const ctx = makeCtx({ name: "freshbud", parentName: "neo" });
    await finalizeBud(ctx);

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.sync_peers).toEqual(["freshbud"]);
  });

  test("no entry matches parentName → zero fleet writes", async () => {
    const { entry, path } = seedFleetFile(8, "not-neo", {
      name: "08-not-neo",
      windows: [],
      sync_peers: [],
    });
    const before = readFileSync(path, "utf-8");
    fleetEntriesOverride = [entry];

    const ctx = makeCtx({ name: "newbud", parentName: "neo" });
    await finalizeBud(ctx);

    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("root bud (parentName null) → loadFleetEntries never consulted", async () => {
    // Populate fleetEntries with a bogus file path — the root branch must short-circuit
    // before reaching the loop. If it didn't, reading "99-missing.json" would blow up.
    fleetEntriesOverride = [{
      file: "99-missing.json",
      num: 99,
      groupName: "missing",
      session: { name: "99-missing", windows: [] },
    }];

    const ctx = makeCtx({ parentName: null });
    await finalizeBud(ctx);

    expect(cmdWakeCalls).toHaveLength(1);
  });
});

// ─── Step 8: wake the bud ───────────────────────────────────────────────────

describe("finalizeBud — step 8 (wake)", () => {
  test("default opts → cmdWake(name, { noAttach: true, repoPath })", async () => {
    const ctx = makeCtx({ name: "wakebud", parentName: null, opts: {} });
    await finalizeBud(ctx);

    expect(cmdWakeCalls).toHaveLength(1);
    expect(cmdWakeCalls[0].name).toBe("wakebud");
    expect(cmdWakeCalls[0].opts).toEqual({ noAttach: true, repoPath: ctx.budRepoPath });
  });

  test("--issue → fetchIssuePrompt called with (issue, `${org}/${repo}`) + wakeOpts has prompt + task", async () => {
    fetchIssuePromptReturn = "<fetched-issue-body>";
    const ctx = makeCtx({
      name: "issuebud",
      parentName: null,
      org: "my-gh-org",
      budRepoName: "issuebud-oracle",
      opts: { issue: 201 },
    });
    await finalizeBud(ctx);

    expect(fetchIssuePromptCalls).toEqual([{ issue: 201, repo: "my-gh-org/issuebud-oracle" }]);
    expect(cmdWakeCalls).toHaveLength(1);
    expect(cmdWakeCalls[0].opts).toEqual({
      noAttach: true,
      repoPath: ctx.budRepoPath,
      prompt: "<fetched-issue-body>",
      task: "issue-201",
    });
  });

  test("--repo → ensureCloned called (before cmdWake)", async () => {
    const ctx = makeCtx({ parentName: null, opts: { repo: "someorg/somerepo" } });
    await finalizeBud(ctx);

    expect(ensureClonedCalls).toEqual(["someorg/somerepo"]);
    expect(cmdWakeCalls).toHaveLength(1);
  });

  test("cmdWake throws → error swallowed, finalizeBud keeps going to step 8.25", async () => {
    cmdWakeThrow = new Error("tmux refused");
    process.env.TMUX = "/tmp/tmux-test";
    const ctx = makeCtx({ parentName: null, opts: { split: true } });
    await finalizeBud(ctx);

    // Wake was attempted AND split still ran (proves we didn't early-exit).
    expect(cmdWakeCalls).toHaveLength(1);
    expect(cmdSplitCalls).toEqual([ctx.name]);
  });
});

// ─── Step 8.25: --split optional pane ───────────────────────────────────────

describe("finalizeBud — step 8.25 (--split)", () => {
  test("--split + TMUX env set → cmdSplit(name) invoked", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,5";
    const ctx = makeCtx({ name: "splitbud", parentName: null, opts: { split: true } });
    await finalizeBud(ctx);

    expect(cmdSplitCalls).toEqual(["splitbud"]);
  });

  test("--split + NO TMUX env → cmdSplit NOT called (warning-only branch)", async () => {
    const warns: string[] = [];
    console.log = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    const ctx = makeCtx({ parentName: null, opts: { split: true } });
    await finalizeBud(ctx);

    expect(cmdSplitCalls).toEqual([]);
    expect(warns.some((w) => w.includes("--split requires tmux session"))).toBe(true);
  });

  test("no --split + no TMUX → cmdSplit not called, no warning", async () => {
    const ctx = makeCtx({ parentName: null, opts: {} });
    await finalizeBud(ctx);

    expect(cmdSplitCalls).toEqual([]);
  });

  test("--split + TMUX, cmdSplit throws → error caught, finalizeBud still reaches step 8.5", async () => {
    process.env.TMUX = "/tmp/tmux-test";
    cmdSplitThrow = new Error("pane died");
    const ctx = makeCtx({ parentName: null, opts: { split: true, repo: "org/repo" } });
    await finalizeBud(ctx);

    expect(cmdSplitCalls).toHaveLength(1);
    // 8.5 reached — ensureCloned was called earlier in step 8, proving we got past the split catch.
    expect(ensureClonedCalls).toEqual(["org/repo"]);
  });
});

// ─── Step 8.5: copy local project ψ/ when --repo used ───────────────────────

describe("finalizeBud — step 8.5 (local ψ/ copy)", () => {
  test("--repo + local ψ/memory exists with all 3 subdirs → syncDir called 3× w/ correct src/dst", async () => {
    const ghqRoot = mkdtempSync(join(tmpBase, "ghq-"));
    const repoSlug = "theorg/theproj";
    // #680 — getGhqRoot() returns bare root; finalizeBud appends "github.com".
    const localPsi = join(ghqRoot, "github.com", repoSlug, "ψ", "memory");
    for (const sub of ["learnings", "retrospectives", "traces"]) {
      mkdirSync(join(localPsi, sub), { recursive: true });
    }

    const ctx = makeCtx({ parentName: null, ghqRoot, opts: { repo: repoSlug } });
    await finalizeBud(ctx);

    expect(syncDirCalls).toHaveLength(3);
    const subs = syncDirCalls.map((c) => c.src.split("/").pop());
    expect(subs.sort()).toEqual(["learnings", "retrospectives", "traces"]);
    for (const call of syncDirCalls) {
      expect(call.src.startsWith(localPsi)).toBe(true);
      expect(call.dst.startsWith(join(ctx.psiDir, "memory"))).toBe(true);
    }
  });

  test("--repo + ψ/memory exists but only some subdirs present → syncDir only for present", async () => {
    const ghqRoot = mkdtempSync(join(tmpBase, "ghq-"));
    const repoSlug = "theorg/partial";
    // #680 — getGhqRoot() returns bare root; finalizeBud appends "github.com".
    const localPsi = join(ghqRoot, "github.com", repoSlug, "ψ", "memory");
    mkdirSync(join(localPsi, "learnings"), { recursive: true });
    // retrospectives + traces intentionally absent.

    const ctx = makeCtx({ parentName: null, ghqRoot, opts: { repo: repoSlug } });
    await finalizeBud(ctx);

    expect(syncDirCalls).toHaveLength(1);
    expect(syncDirCalls[0].src.endsWith("/learnings")).toBe(true);
  });

  test("--repo but no local ψ/memory → syncDir never called", async () => {
    const ghqRoot = mkdtempSync(join(tmpBase, "ghq-"));
    // Do NOT create ψ/memory under ghqRoot/org/repo.

    const ctx = makeCtx({ parentName: null, ghqRoot, opts: { repo: "org/absent" } });
    await finalizeBud(ctx);

    expect(syncDirCalls).toHaveLength(0);
    expect(ensureClonedCalls).toEqual(["org/absent"]);
  });

  test("no --repo → syncDir and ensureCloned both skipped", async () => {
    const ctx = makeCtx({ parentName: null, opts: {} });
    await finalizeBud(ctx);

    expect(syncDirCalls).toHaveLength(0);
    expect(ensureClonedCalls).toHaveLength(0);
  });
});
