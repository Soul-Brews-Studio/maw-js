/**
 * #1576 — wake should leave a recovery snapshot for ordinary existing-session wakes.
 *
 * Regression: snapshotting used to live only at the very bottom of cmdWake, so
 * the common "session/window already running" return path skipped it entirely.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const repoPath = "/repo/mawjs-oracle";
let snapshots: string[] = [];
let lifecycleCalls = 0;
let splitCalls: string[] = [];
let openCalls: string[] = [];
let findWorktreesCalls = 0;

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async () => "",
  restoreTabOrder: async () => 0,
  takeSnapshot: async (trigger: string) => {
    snapshots.push(trigger);
    return `/tmp/${trigger}.json`;
  },
  getPaneInfos: async (targets: string[]) => Object.fromEntries(
    targets.map((target) => [target, { command: "claude" }]),
  ),
  isAgentCommand: () => true,
  tmux: {
    listSessions: async () => [{ name: "54-mawjs" }],
    listWindows: async () => [{ index: 0, name: "mawjs-oracle", active: true }],
    newSession: async () => {},
    newWindow: async () => {},
    sendText: async () => {},
    selectWindow: async () => {},
    hasSession: async () => true,
  },
}));

mock.module(join(import.meta.dir, "../../src/config"), () => ({
  buildCommandInDir: (windowName: string, cwd: string) => `cd ${cwd} && ${windowName}`,
  cfgTimeout: () => 0,
  cfgLimit: () => 0,
  loadConfig: () => ({ node: "m5" }),
  saveConfig: () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-resolve"), () => ({
  resolveOracle: async () => ({ repoPath, repoName: "mawjs-oracle", parentDir: "/repo" }),
  findWorktrees: async () => { findWorktreesCalls++; return []; },
  findReusableWorktreeBySlug: () => null,
  getSessionMap: () => ({}),
  resolveFleetSession: () => null,
  detectSession: async () => "54-mawjs",
  setSessionEnv: async () => {},
  sanitizeBranchName: (value: string) => value,
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-session"), () => ({
  attachToSession: async () => {},
  ensureSessionRunning: async () => 0,
  createWorktree: async () => { throw new Error("createWorktree should not run"); },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-maybe-split"), () => ({
  maybeSplit: async (target: string) => { splitCalls.push(target); },
  maybeOpenWindow: async (target: string) => { openCalls.push(target); },
}));

mock.module(join(import.meta.dir, "../../src/plugin/lifecycle"), () => ({
  runWakeLifecycleHooks: async () => { lifecycleCalls++; return { phase: "wake", ran: 0, skipped: 0, failed: 0 }; },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-target"), () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-concurrency"), () => ({
  assertAgentCapacity: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/leaf"), () => ({
  writeSignal: () => "/tmp/signal.json",
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: () => ({ wake: false, reason: "already-live" }),
}));

const { cmdWake } = await import("../../src/commands/shared/wake-cmd");

beforeEach(() => {
  snapshots = [];
  lifecycleCalls = 0;
  splitCalls = [];
  openCalls = [];
  findWorktreesCalls = 0;
});

describe("cmdWake recovery snapshots (#1576)", () => {
  test("existing running session/window records a wake snapshot before returning", async () => {
    const target = await cmdWake("mawjs", { repoPath, noRehydrate: true });

    expect(target).toBe("54-mawjs:mawjs-oracle");
    expect(lifecycleCalls).toBe(1);
    expect(splitCalls).toEqual(["54-mawjs:mawjs-oracle"]);
    expect(openCalls).toEqual(["54-mawjs:mawjs-oracle"]);
    expect(snapshots).toEqual(["wake"]);
  });

  test("read-only wake previews do not record snapshots", async () => {
    await cmdWake("mawjs", { repoPath, dryRun: true });
    await cmdWake("mawjs", { repoPath, listWt: true });

    // dry-run previews rehydrate worktrees, and --list previews worktrees.
    expect(findWorktreesCalls).toBe(2);
    expect(snapshots).toEqual([]);
  });
});
