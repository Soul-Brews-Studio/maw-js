import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const repoPath = "/repo/volt-oracle";
let newWindows: Array<{ session: string; name: string; cwd?: string }> = [];
let sentText: string[] = [];
let detectSessionCalls = 0;
let restoreTabOrderCalls = 0;
let findWorktreesCalls = 0;

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async () => "",
  restoreTabOrder: async () => { restoreTabOrderCalls++; return 0; },
  takeSnapshot: async () => "/tmp/wake.json",
  getPaneInfos: async (targets: string[]) => Object.fromEntries(targets.map((t) => [t, { command: "", cwd: "/tmp" }])),
  isAgentCommand: () => false,
  tmux: {
    hasSession: async (name: string) => name === "project",
    listSessions: async () => [{ name: "project" }],
    listWindows: async (session: string) => session === "project"
      ? [{ index: 0, name: "lead", active: true }]
      : [],
    newSession: async () => {},
    newWindow: async (session: string, name: string, opts: any = {}) => {
      newWindows.push({ session, name, cwd: opts.cwd });
    },
    sendText: async (target: string) => { sentText.push(target); },
    selectWindow: async () => {},
    setEnvironment: async () => {},
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
  resolveOracle: async () => ({ repoPath, repoName: "volt-oracle", parentDir: "/repo" }),
  findWorktrees: async () => { findWorktreesCalls++; return []; },
  findReusableWorktreeBySlug: () => null,
  getSessionMap: () => ({}),
  resolveFleetSession: () => null,
  detectSession: async () => { detectSessionCalls++; return "51-volt"; },
  setSessionEnv: async () => {},
  sanitizeBranchName: (value: string) => value,
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-session"), () => ({
  attachToSession: async () => {},
  reconcileParentClaudeDir: async () => {},
  ensureSessionRunning: async () => 0,
  createWorktree: async () => { throw new Error("createWorktree should not run"); },
}));

mock.module(join(import.meta.dir, "../../src/commands/shared/wake-maybe-split"), () => ({
  maybeSplit: async () => {},
  maybeOpenWindow: async () => {},
}));

mock.module(join(import.meta.dir, "../../src/plugin/lifecycle"), () => ({
  runWakeLifecycleHooks: async () => ({ phase: "wake", ran: 0, skipped: 0, failed: 0 }),
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
  shouldAutoWake: () => ({ wake: false, reason: "foreign-session" }),
}));

const { cmdWake } = await import("../../src/commands/shared/wake-cmd");

beforeEach(() => {
  newWindows = [];
  sentText = [];
  detectSessionCalls = 0;
  restoreTabOrderCalls = 0;
  findWorktreesCalls = 0;
});

describe("cmdWake --session", () => {
  test("wakes oracle as a window named after the oracle in a foreign workspace session", async () => {
    const target = await cmdWake("volt", { repoPath, session: "project", noRehydrate: true });

    expect(target).toBe("project:volt");
    expect(detectSessionCalls).toBe(0);
    expect(restoreTabOrderCalls).toBe(0);
    expect(findWorktreesCalls).toBe(0);
    expect(newWindows).toEqual([{ session: "project", name: "volt", cwd: repoPath }]);
    expect(sentText).toEqual(["project:volt"]);
  });
});
