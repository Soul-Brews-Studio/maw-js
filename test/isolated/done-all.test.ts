/**
 * done-all.test.ts — #1380 regression guard.
 *
 * `maw done --all` batches the existing single-window done lifecycle across
 * the current tmux session, but it must never target the lead window or a
 * same-named window from another session.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

type Window = { index: number; name: string; active: boolean };
type Session = { name: string; windows: Window[] };

let sessions: Session[] = [];
let tmuxCommands: string[] = [];
let autoSaveCalls: Array<{ windowName: string; sessionName: string; dryRun?: boolean }> = [];
let inboxSignals: Array<{ windowName: string; sessionName: string }> = [];
let worktreeLookups: string[] = [];
let removedFleetEntries: string[] = [];
let snapshots: string[] = [];
let currentSession = "work";
let tmuxRunFails = false;
let killWindowFails = false;
let autoSaveErrorFor: string | null = null;
let tmuxCurrentWindowIndex = 0;
let teamCharterPath: string | null = null;
let teamRepoRoot = "/tmp/mawjs-team-root";
let teamCharter: { name: string; members: Array<{ name: string; role: string; isLead?: boolean }> } = {
  name: "work",
  members: [
    { name: "lead", role: "lead" },
    { name: "alpha", role: "worker" },
  ],
};
let resolveOracleCalls: string[] = [];
let resolveOracleResult: { repoPath: string; repoName: string; parentDir: string } = {
  repoPath: "/tmp/mawjs-oracle",
  repoName: "mawjs-oracle",
  parentDir: "/tmp",
};

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  // done-deps.ts (loaded via impl.ts) resolves these from the sdk; the
  // single-window helpers that would use them are mocked out below, so no-ops
  // are enough to satisfy the imports for the done --all lifecycle tests.
  hostExec: async () => "",
  loadFleetEntries: () => [],
  get FLEET_DIR() { return "/tmp/maw-test-fleet"; },
  takeSnapshot: async (trigger: string) => { snapshots.push(trigger); return "/tmp/snapshot.json"; },
  tmux: {
    run: async (subcommand: string, ...args: string[]) => {
      tmuxCommands.push(["run", subcommand, ...args].join(" "));
      if (tmuxRunFails) throw new Error("no current tmux session");
      if (subcommand === "display-message") {
        const format = args.includes("#{session_name}\t#{window_index}")
          ? "#{session_name}\t#{window_index}"
          : args[1] === "#{session_name}\t#{window_index}"
            ? "#{session_name}\t#{window_index}"
            : args[0];

        if (format === "#{session_name}\t#{window_index}") {
          return `${currentSession}\t${tmuxCurrentWindowIndex}\n`;
        }
        if (format === "#{session_name}") return `${currentSession}\n`;
        return `${currentSession}\n`;
      }
      return "";
    },
    killWindow: async (target: string) => {
      tmuxCommands.push(`kill ${target}`);
      if (killWindowFails) throw new Error("kill failed");
    },
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => "/ghq",
}));

mock.module("maw-js/core/matcher/normalize-target", () => ({
  normalizeTarget: (target: string) => target,
}));

mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/done/done-autosave"), () => ({
  // signalParentInbox is sync and self-swallowing in production (a signal error
  // is logged, never thrown), so the mock mirrors that: it records the signal
  // and never throws.
  signalParentInbox: (windowName: string, sessionName: string) => {
    inboxSignals.push({ windowName, sessionName });
  },
  autoSave: async (windowName: string, sessionName: string, opts: { dryRun?: boolean }) => {
    autoSaveCalls.push({ windowName, sessionName, dryRun: opts.dryRun });
    if (autoSaveErrorFor === windowName) throw new Error("autosave failed");
  },
}));

mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/done/done-worktree"), () => ({
  removeWorktreeViaConfig: async (windowNameLower: string) => {
    worktreeLookups.push(`config:${windowNameLower}`);
    return false;
  },
  removeWorktreeByGhqScan: async (windowName: string) => {
    worktreeLookups.push(`ghq:${windowName}`);
    return false;
  },
  removeFromFleetConfig: (windowNameLower: string) => {
    removedFleetEntries.push(windowNameLower);
    return false;
  },
  warnRemainingWorktrees: async () => [],
}));

mock.module("maw-js/commands/shared/wake-resolve", () => ({
  resolveOracle: async (oracle: string) => {
    resolveOracleCalls.push(oracle);
    return resolveOracleResult;
  },
}));

mock.module("maw-js/vendor/mpr-plugins/team/team-charter", () => ({
  readTeamCharter: () => teamCharter,
}));

mock.module("maw-js/vendor/mpr-plugins/team/team-liveness", () => ({
  findRepoRoot: () => teamRepoRoot,
  resolveCharterPath: () => teamCharterPath,
}));

const { cmdDoneAll } = await import("../../src/vendor/mpr-plugins/done/impl");
const donePlugin = await import("../../src/vendor/mpr-plugins/done/index");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  sessions = [
    {
      name: "work",
      windows: [
        { index: 0, name: "lead", active: true },
        { index: 1, name: "alpha", active: false },
        { index: 2, name: "duplicate", active: false },
      ],
    },
    {
      name: "other",
      windows: [
        { index: 0, name: "other-lead", active: true },
        { index: 1, name: "duplicate", active: false },
      ],
    },
  ];
  currentSession = "work";
  tmuxCommands = [];
  autoSaveCalls = [];
  inboxSignals = [];
  worktreeLookups = [];
  removedFleetEntries = [];
  snapshots = [];
  tmuxRunFails = false;
  killWindowFails = false;
  autoSaveErrorFor = null;
  tmuxCurrentWindowIndex = 0;
  teamCharterPath = null;
  teamCharter = {
    name: "work",
    members: [
      { name: "lead", role: "lead" },
      { name: "alpha", role: "worker" },
    ],
  };
  teamRepoRoot = "/tmp/mawjs-team-root";
  resolveOracleCalls = [];
  resolveOracleResult = {
    repoPath: "/tmp/mawjs-oracle",
    repoName: "mawjs-oracle",
    parentDir: "/tmp",
  };
});

describe("cmdDoneAll", () => {
  test("dry-run processes only non-lead windows in the current session", async () => {
    const summary = await cmdDoneAll({ dryRun: true });

    expect(summary).toEqual({
      sessionName: "work",
      processed: ["alpha", "duplicate"],
      skipped: [],
    });
    expect(autoSaveCalls).toEqual([
      { windowName: "alpha", sessionName: "work", dryRun: true },
      { windowName: "duplicate", sessionName: "work", dryRun: true },
    ]);
    expect(inboxSignals).toEqual([]);
    expect(tmuxCommands).not.toContain("kill work:lead");
    expect(tmuxCommands).not.toContain("kill other:duplicate");
    expect(worktreeLookups).toEqual([]);
    expect(removedFleetEntries).toEqual([]);
  });

  test("protects the configured lead window by name when lead index is not smallest", async () => {
    sessions = [{
      name: "139-mawjs",
      windows: [
        { index: 0, name: "mawjs-codex-1", active: true },
        { index: 2, name: "mawjs-oracle", active: false },
      ],
    }];
    currentSession = "139-mawjs";
    tmuxCurrentWindowIndex = 0;
    teamCharterPath = "/tmp/mawjs-team.yaml";
    teamCharter = {
      name: "mawjs-m5",
      members: [
        { name: "mawjs-oracle", role: "lead", isLead: true },
        { name: "mawjs-codex-1", role: "agent" },
      ],
    };

    const { cmdDone } = await import("../../src/vendor/mpr-plugins/done/impl");

    await cmdDone("mawjs-codex-1", { force: true });
    expect(tmuxCommands).toContain("kill 139-mawjs:mawjs-codex-1");

    await expect(cmdDone("mawjs-oracle", { force: true })).rejects.toThrow("refusing to done lead window");
    expect(tmuxCommands).toContain("run display-message -p #{session_name}\t#{window_index}");
  });

  test("refuses done lead window when current tmux identity is unavailable (fail-closed)", async () => {
    sessions = [{
      name: "139-mawjs",
      windows: [
        { index: 0, name: "mawjs-codex-1", active: true },
        { index: 2, name: "mawjs-oracle", active: false },
      ],
    }];
    currentSession = "139-mawjs";
    tmuxCurrentWindowIndex = 2;
    tmuxRunFails = true; // subshell / no tmux → identity cannot be confirmed
    teamCharterPath = "/tmp/mawjs-team.yaml";
    teamCharter = {
      name: "mawjs-m5",
      members: [
        { name: "mawjs-oracle", role: "lead" },
        { name: "mawjs-codex-1", role: "agent" },
      ],
    };

    const { cmdDone } = await import("../../src/vendor/mpr-plugins/done/impl");

    // Fail-closed: when tmux identity is unavailable we cannot prove the caller
    // is in the lead window, so refuse — and make ZERO changes (the guard runs
    // before any signal / kill / worktree / fleet mutation).
    await expect(cmdDone("mawjs-oracle", { force: true })).rejects.toThrow("refusing to done lead window");
    expect(inboxSignals).toEqual([]);
    expect(tmuxCommands).not.toContain("kill 139-mawjs:mawjs-oracle");
    expect(worktreeLookups).toEqual([]);
    expect(removedFleetEntries).toEqual([]);
    expect(snapshots).toEqual([]);
    // the guard still performs the identity read that let it decide to refuse
    expect(tmuxCommands).toContain("run display-message -p #{session_name}\t#{window_index}");
  });

  test("--force skips auto-save and kills only current-session non-lead windows", async () => {
    const summary = await cmdDoneAll({ force: true });

    expect(summary.processed).toEqual(["alpha", "duplicate"]);
    expect(autoSaveCalls).toEqual([]);
    expect(tmuxCommands).toContain("kill work:alpha");
    expect(tmuxCommands).toContain("kill work:duplicate");
    expect(tmuxCommands).not.toContain("kill work:lead");
    expect(tmuxCommands).not.toContain("kill other:duplicate");
    expect(worktreeLookups).toEqual([
      "config:alpha",
      "ghq:alpha",
      "config:duplicate",
      "ghq:duplicate",
    ]);
    expect(removedFleetEntries).toEqual(["alpha", "duplicate"]);
    expect(snapshots).toEqual(["done", "done"]);
  });

  test("refuses to guess a current session when tmux cannot identify one", async () => {
    tmuxRunFails = true;

    const summary = await cmdDoneAll({ force: true });

    expect(summary).toEqual({ sessionName: null, processed: [], skipped: [] });
    expect(tmuxCommands).toEqual(["run display-message -p #{session_name}"]);
    expect(autoSaveCalls).toEqual([]);
    expect(inboxSignals).toEqual([]);
    expect(worktreeLookups).toEqual([]);
  });

  test("falls back to the only session when tmux cannot identify one", async () => {
    tmuxRunFails = true;
    sessions = [{
      name: "solo",
      windows: [
        { index: 0, name: "lead", active: true },
        { index: 2, name: "worker", active: false },
      ],
    }];

    const summary = await cmdDoneAll({ force: true });

    expect(summary).toEqual({ sessionName: "solo", processed: ["worker"], skipped: [] });
    expect(tmuxCommands).toContain("kill solo:worker");
    expect(worktreeLookups).toEqual(["config:worker", "ghq:worker"]);
  });

  test("reports no sessions without attempting cleanup", async () => {
    tmuxRunFails = true;
    sessions = [];

    const summary = await cmdDoneAll({ force: true });

    expect(summary).toEqual({ sessionName: null, processed: [], skipped: [] });
    expect(tmuxCommands).toEqual(["run display-message -p #{session_name}"]);
    expect(worktreeLookups).toEqual([]);
    expect(snapshots).toEqual([]);
  });



  test("reports a stale current session and an empty current session without processing", async () => {
    currentSession = "ghost";
    let summary = await cmdDoneAll({ force: true });
    expect(summary).toEqual({ sessionName: null, processed: [], skipped: [] });

    sessions = [{ name: "solo", windows: [{ index: 0, name: "lead", active: true }] }];
    currentSession = "solo";
    summary = await cmdDoneAll({ force: true });
    expect(summary).toEqual({ sessionName: "solo", processed: [], skipped: [] });
    expect(tmuxCommands).not.toContain("kill solo:lead");
  });

  test("cmdDone logs already-closed windows and dry-run missing windows", async () => {
    killWindowFails = true;
    await cmdDoneAll({ force: true });
    expect(tmuxCommands).toContain("kill work:alpha");

    const { cmdDone } = await import("../../src/vendor/mpr-plugins/done/impl");
    await expect(cmdDone("missing-window", { dryRun: true })).rejects.toThrow("no done target matched 'missing-window'");
    expect(autoSaveCalls.map(c => c.windowName)).not.toContain("missing-window");
  });

  test("cmdDone signals, autosaves, kills, scans cleanup, and snapshots a running window", async () => {
    const { cmdDone } = await import("../../src/vendor/mpr-plugins/done/impl");

    await cmdDone("alpha");

    expect(inboxSignals).toEqual([{ windowName: "alpha", sessionName: "work" }]);
    expect(autoSaveCalls).toEqual([{ windowName: "alpha", sessionName: "work", dryRun: undefined }]);
    expect(tmuxCommands).toContain("kill work:alpha");
    expect(worktreeLookups).toEqual(["config:alpha", "ghq:alpha"]);
    expect(removedFleetEntries).toEqual(["alpha"]);
    expect(snapshots).toEqual(["done"]);
  });

  test("cmdDoneAll records skipped windows when the single-window lifecycle throws", async () => {
    autoSaveErrorFor = "alpha";

    const summary = await cmdDoneAll({});

    expect(summary.processed).toEqual(["duplicate"]);
    expect(summary.skipped).toEqual(["alpha"]);
    // The completion signal is bound to successful preservation: alpha's autoSave
    // threw, so alpha is NOT signaled (no false completion); only the window that
    // preserved cleanly (duplicate) is signaled.
    expect(inboxSignals).toEqual([{ windowName: "duplicate", sessionName: "work" }]);
  });

  test("plugin CLI parses --all without a positional window name", async () => {
    const output: string[] = [];
    const result = await donePlugin.default({
      source: "cli",
      args: ["--all", "--dry-run"],
      writer: (...args: unknown[]) => output.push(args.map(String).join(" ")),
    } as any);

    expect(result.ok).toBe(true);
    expect(autoSaveCalls.map(c => c.windowName)).toEqual(["alpha", "duplicate"]);
    expect(output.join("\n")).toContain("would process 2 non-lead window(s) in work");
  });


  test("cmdDoneAll({ oracle }) accepts wake-style fuzzy resolver results for compact fleet sessions", async () => {
    const workTree = mkdtempSync(join(tmpdir(), "maw-done-all-fuzzy-"));
    sessions = [
      {
        name: "33-arraoraclev3",
        windows: [
          { index: 0, name: "lead", active: true },
          { index: 2, name: "worker", active: false },
        ],
      },
      {
        name: "other",
        windows: [
          { index: 0, name: "lead", active: true },
          { index: 1, name: "other-worker", active: false },
        ],
      },
    ];
    tmuxRunFails = true;
    resolveOracleResult = {
      repoPath: workTree,
      repoName: "arra-oracle-v3-oracle",
      parentDir: join(workTree, ".."),
    };

    const summary = await cmdDoneAll({ oracle: "v3", force: true });

    expect(summary).toEqual({ sessionName: "33-arraoraclev3", processed: ["worker"], skipped: [] });
    expect(resolveOracleCalls).toEqual(["v3"]);
    expect(tmuxCommands).toContain("kill 33-arraoraclev3:worker");
    expect(tmuxCommands).not.toContain("kill other:other-worker");
    rmSync(workTree, { recursive: true, force: true });
  });
  test("cmdDoneAll({ oracle }) resolves oracle, cds internally, and processes that oracle session", async () => {
    const workTree = mkdtempSync(join(tmpdir(), "maw-done-all-oracle-"));
    const previousCwd = process.cwd();
    sessions = [{
      name: "mawjs",
      windows: [
        { index: 0, name: "lead", active: true },
        { index: 1, name: "alpha", active: false },
      ],
    }];
    currentSession = "mawjs";
    resolveOracleResult = {
      repoPath: workTree,
      repoName: "mawjs-oracle",
      parentDir: join(workTree, ".."),
    };

    const summary = await cmdDoneAll({ oracle: "mawjs" });

    expect(summary).toEqual({ sessionName: "mawjs", processed: ["alpha"], skipped: [] });
    expect(resolveOracleCalls).toEqual(["mawjs"]);
    expect(process.cwd()).toEqual(previousCwd);
    expect(autoSaveCalls).toEqual([{ windowName: "alpha", sessionName: "mawjs", dryRun: undefined }]);
    rmSync(workTree, { recursive: true, force: true });
  });
});
