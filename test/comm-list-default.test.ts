import { beforeEach, describe, expect, test } from "bun:test";
import { cmdList, renderSessionName, type CommListDeps } from "../src/commands/shared/comm-list";

type Session = Awaited<ReturnType<NonNullable<CommListDeps["listSessions"]>>>[number];
type PaneInfoMap = Awaited<ReturnType<NonNullable<CommListDeps["getPaneInfos"]>>>;
type Worktree = Awaited<ReturnType<NonNullable<CommListDeps["scanWorktrees"]>>>[number];

let sessions: Session[] = [];
let paneInfos: PaneInfoMap = {};
let paneTargets: string[][] = [];
let worktrees: Worktree[] = [];
let scanError: Error | null = null;
let cleanupCalls: string[] = [];
let cleanupErrors = new Map<string, Error>();
let cleanupLogs = new Map<string, string[]>();
let logs: string[] = [];
let errors: string[] = [];
let env: Record<string, string | undefined> = {};
let snapshot: { timestamp: string; sessions: Array<{ name: string }> } | null = null;
let snapshotThrows = false;
let now = Date.parse("2026-05-17T12:00:00.000Z");

function deps(): CommListDeps {
  return {
    listSessions: async () => sessions,
    getPaneInfos: async (targets: string[]) => {
      paneTargets.push([...targets]);
      return paneInfos;
    },
    scanWorktrees: async () => {
      if (scanError) throw scanError;
      return worktrees;
    },
    cleanupWorktree: async (path: string) => {
      cleanupCalls.push(path);
      const error = cleanupErrors.get(path);
      if (error) throw error;
      return cleanupLogs.get(path) ?? [];
    },
    isAgentCommand: (command: string | null | undefined) => /^(claude|codex|node)$/i.test(String(command ?? "").trim()),
    latestSnapshot: () => {
      if (snapshotThrows) throw new Error("snapshot unavailable");
      return snapshot;
    },
    log: {
      log: (...args: unknown[]) => logs.push(args.join(" ")),
      error: (...args: unknown[]) => errors.push(args.join(" ")),
    },
    env,
    now: () => now,
  };
}

function session(name: string, windows: Session["windows"]): Session {
  return { name, windows };
}

function text(): string {
  return [...logs, ...errors].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("comm-list default-suite seams", () => {
  beforeEach(() => {
    sessions = [];
    paneInfos = {};
    paneTargets = [];
    worktrees = [];
    scanError = null;
    cleanupCalls = [];
    cleanupErrors = new Map();
    cleanupLogs = new Map();
    logs = [];
    errors = [];
    env = {};
    snapshot = null;
    snapshotThrows = false;
    now = Date.parse("2026-05-17T12:00:00.000Z");
  });

  test("renderSessionName distinguishes source, suffixed view, and maw-view sessions", () => {
    expect(renderSessionName("08-mawjs")).toBe("\x1b[36m08-mawjs\x1b[0m");
    expect(renderSessionName("08-mawjs-view")).toBe("\x1b[90m08-mawjs-view\x1b[0m \x1b[90m[view]\x1b[0m");
    expect(renderSessionName("maw-view")).toBe("\x1b[90mmaw-view\x1b[0m \x1b[90m[view]\x1b[0m");
    expect(renderSessionName("preview-win")).toBe("\x1b[36mpreview-win\x1b[0m");
  });

  test("cmdList renders pane states and filters diagnostic view sessions", async () => {
    sessions = [
      session("08-mawjs", [
        { index: 0, name: "active-agent", active: true },
        { index: 1, name: "inactive-agent", active: false },
        { index: 2, name: "shell", active: false },
        { index: 3, name: "deleted-agent", active: true },
        { index: 4, name: "missing-info", active: false },
      ]),
      session("08-mawjs-view", [{ index: 0, name: "view-pane", active: false }]),
      session("08-mawjs-view-diag", [{ index: 0, name: "diag-pane", active: true }]),
    ];
    paneInfos = {
      "08-mawjs:0": { command: "claude", cwd: "/home/nat" },
      "08-mawjs:1": { command: "Node", cwd: "/home/nat" },
      "08-mawjs:2": { command: "zsh", cwd: "/home/nat" },
      "08-mawjs:3": { command: "claude", cwd: "/old/path (deleted)" },
      "08-mawjs-view:0": { command: "zsh", cwd: "/tmp (dead)" },
    };

    await cmdList({}, deps());

    expect(paneTargets).toEqual([[
      "08-mawjs:0",
      "08-mawjs:1",
      "08-mawjs:2",
      "08-mawjs:3",
      "08-mawjs:4",
      "08-mawjs-view:0",
    ]]);
    expect(logs.join("\n")).toContain("\x1b[32m●\x1b[0m");
    expect(logs.join("\n")).toContain("\x1b[34m●\x1b[0m");
    expect(logs.join("\n")).toContain("\x1b[31m●\x1b[0m");
    expect(text()).toContain("(zsh)");
    expect(text()).toContain("(path deleted)");
    expect(text()).toContain("(?)");
    expect(text()).toContain("[view]");
    expect(text()).not.toContain("diag-pane");
  });

  test("orphan scan renders stale/orphan warnings and keeps default listing read-only", async () => {
    sessions = [session("08-mawjs", [{ index: 0, name: "mawjs-oracle", active: true }])];
    paneInfos = { "08-mawjs:0": { command: "claude", cwd: "/home/nat" } };
    worktrees = [
      { path: "/ghq/org/repo.wt-1-stale", status: "stale", name: "1-stale" },
      { path: "", status: "orphan", name: "fallback-orphan" },
      { path: "/ghq/org/repo", status: "active", name: "main" },
    ];

    await cmdList({}, deps());

    expect(cleanupCalls).toEqual([]);
    expect(text()).toContain("repo.wt-1-stale");
    expect(text()).toContain("(no tmux window)");
    expect(text()).toContain("fallback-orphan");
    expect(text()).toContain("(orphaned (prunable))");
    expect(text()).toContain("→ maw ls --fix");
    expect(text()).not.toContain("main");
  });

  test("scan errors are silent by default and diagnostic when MAW_DEBUG is set", async () => {
    sessions = [session("08-mawjs", [{ index: 0, name: "mawjs-oracle", active: true }])];
    paneInfos = { "08-mawjs:0": { command: "claude", cwd: "/home/nat" } };
    scanError = new Error("scan exploded");

    await cmdList({}, deps());
    expect(text()).toContain("mawjs-oracle");
    expect(errors.join("\n")).not.toContain("scanWorktrees failed");

    errors = [];
    env.MAW_DEBUG = "1";
    await cmdList({}, deps());
    expect(errors.join("\n")).toContain("scanWorktrees failed");
    expect(errors.join("\n")).toContain("scan exploded");
  });

  test("empty state renders recent snapshots and onboarding hints", async () => {
    snapshot = {
      timestamp: "2026-05-17T10:00:00.000Z",
      sessions: [{ name: "47-mawjs" }, { name: "54-mawjs" }],
    };

    await cmdList({}, deps());

    expect(text()).toContain("No active sessions.");
    expect(text()).toContain("Last snapshot (2h ago)");
    expect(text()).toContain("47-mawjs");
    expect(text()).toContain("maw fleet restore --all");
    expect(text()).toContain("maw bud <name>");
    expect(text()).toContain("maw wake <name>");
  });

  test("empty state ignores stale or throwing snapshot lookups", async () => {
    snapshot = {
      timestamp: "2026-05-15T10:00:00.000Z",
      sessions: [{ name: "old" }],
    };

    await cmdList({}, deps());
    expect(text()).toContain("No active sessions.");
    expect(text()).not.toContain("Last snapshot");

    logs = [];
    snapshotThrows = true;
    await cmdList({}, deps());
    expect(text()).toContain("No active sessions.");
    expect(text()).not.toContain("snapshot unavailable");
  });

  test("empty state default snapshot loader remains wired for production callers", async () => {
    const d = deps();
    delete d.latestSnapshot;

    await cmdList({}, d);

    expect(text()).toContain("No active sessions.");
    expect(text()).toContain("maw bud <name>");
  });

  test("--fix prunes all orphans, prints cleanup logs, and reports failures without stopping", async () => {
    worktrees = [
      { path: "/ghq/org/repo.wt-good", status: "stale", name: "good" },
      { path: "/ghq/org/repo.wt-bad", status: "orphan", name: "bad" },
    ];
    cleanupLogs.set("/ghq/org/repo.wt-good", ["removed branch", "deleted dir"]);
    cleanupErrors.set("/ghq/org/repo.wt-bad", new Error("permission denied"));

    await cmdList({ fix: true }, deps());

    expect(cleanupCalls).toEqual(["/ghq/org/repo.wt-good", "/ghq/org/repo.wt-bad"]);
    expect(text()).toContain("pruning 2 orphans");
    expect(text()).toContain("repo.wt-good");
    expect(text()).toContain("removed branch");
    expect(text()).toContain("permission denied");
    expect(text()).toContain("pruned 1/2");
    expect(text()).not.toContain("→ maw ls --fix");
  });

  test("--fix with no orphans reports nothing to prune", async () => {
    sessions = [session("08-mawjs", [{ index: 0, name: "mawjs-oracle", active: true }])];
    paneInfos = { "08-mawjs:0": { command: "claude", cwd: "/home/nat" } };
    worktrees = [{ path: "/ghq/org/repo", status: "active", name: "main" }];

    await cmdList({ fix: true }, deps());

    expect(cleanupCalls).toEqual([]);
    expect(text()).toContain("nothing to prune");
  });
});
