/**
 * Isolated coverage for src/vendor/mpr-plugins/done/done-autosave.ts.
 *
 * The module captures SDK, os, reunion, and soul-sync imports at module load
 * time, so mocks are registered before importing the target module.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-done-autosave-"));

type HostExecHandler = (command: string) => string | Promise<string>;

let homeDir = join(SANDBOX, "home");
let hostExecCalls: string[] = [];
let hostExecHandler: HostExecHandler = () => "";
let sentTexts: Array<{ target: string; text: string }> = [];
let sendTextError: unknown = null;
let reunionCalls: string[] = [];
let soulSyncCalls: Array<{ target?: string; opts?: { cwd?: string } }> = [];
let soulSyncError: unknown = null;

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    return await hostExecHandler(command);
  },
  tmux: {
    sendText: async (target: string, text: string) => {
      sentTexts.push({ target, text });
      if (sendTextError) throw sendTextError;
    },
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/internal/reunion-impl"), () => ({
  cmdReunion: async (windowName?: string) => {
    reunionCalls.push(windowName ?? "");
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/internal/soul-sync-impl"), () => ({
  cmdSoulSync: async (target?: string, opts?: { cwd?: string }) => {
    soulSyncCalls.push({ target, opts });
    if (soulSyncError) throw soulSyncError;
    return [];
  },
}));

const {
  autoSave,
  signalParentInbox,
} = await import("../../src/vendor/mpr-plugins/done/done-autosave.ts?done-autosave-coverage");

beforeEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = join(SANDBOX, "home");
  hostExecCalls = [];
  hostExecHandler = (command) => command.includes("pane_current_path") ? "/repo/worktree\n" : "";
  sentTexts = [];
  sendTextError = null;
  reunionCalls = [];
  soulSyncCalls = [];
  soulSyncError = null;
  delete process.env.CLAUDE_AGENT_NAME;
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

async function captureConsole(fn: () => Promise<void> | void): Promise<string> {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  const capture = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

async function withImmediateTimers(fn: () => Promise<void>): Promise<number[]> {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    delays.push(timeout ?? 0);
    if (typeof handler === "function") handler(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await fn();
    return delays;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

describe("done autosave coverage", () => {
  test("signalParentInbox writes a sanitized parent inbox signal and no-ops when no parent exists", async () => {
    await signalParentInbox("tile-1", "missing", []);
    expect(() => readFileSync(join(homeDir, ".maw", "inbox", "leadpane.jsonl"), "utf-8")).toThrow();

    process.env.CLAUDE_AGENT_NAME = "agent/oracle";
    await signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead pane!!", active: true }] },
    ]);

    const inboxFile = join(homeDir, ".maw", "inbox", "leadpane.jsonl");
    const signal = JSON.parse(readFileSync(inboxFile, "utf-8").trim());
    expect(Number.isNaN(Date.parse(signal.ts))).toBe(false);
    expect(signal).toMatchObject({
      from: "agent/oracle",
      type: "done",
      msg: "worktree tile-1 completed",
      thread: null,
    });
  });

  test("signalParentInbox logs filesystem failures without throwing", async () => {
    homeDir = join(SANDBOX, "blocked-home");
    writeFileSync(homeDir, "not a directory");

    const output = await captureConsole(() => signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead", active: true }] },
    ]));

    expect(output).toContain("inbox signal failed:");
  });

  test("autoSave sends rrr, waits, commits, pushes, reunites, and soul-syncs when pane cwd is known", async () => {
    let delays: number[] = [];
    const output = await captureConsole(async () => {
      delays = await withImmediateTimers(() => autoSave("tile-1", "work", {}));
    });

    expect(delays).toEqual([10_000]);
    expect(sentTexts).toEqual([{ target: "work:tile-1", text: "/rrr" }]);
    expect(hostExecCalls).toEqual([
      "tmux display-message -t 'work:tile-1' -p '#{pane_current_path}'",
      "git -C '/repo/worktree' add -A",
      "git -C '/repo/worktree' commit -m 'chore: auto-save before done'",
      "git -C '/repo/worktree' push",
    ]);
    expect(reunionCalls).toEqual(["tile-1"]);
    expect(soulSyncCalls).toEqual([{ target: undefined, opts: { cwd: "/repo/worktree" } }]);
    expect(output).toContain("/rrr sent (waited 10s)");
    expect(output).toContain("committed changes");
    expect(output).toContain("pushed to remote");
  });

  test("autoSave dry-run explains cwd-aware and missing-pane flows without tmux or cleanup side effects", async () => {
    const cwdOutput = await captureConsole(() => autoSave("tile-1", "work", { dryRun: true }));
    expect(cwdOutput).toContain("would send /rrr to work:tile-1");
    expect(cwdOutput).toContain("would git add + commit + push in /repo/worktree");
    expect(cwdOutput).toContain("would kill window work:tile-1");
    expect(sentTexts).toEqual([]);
    expect(reunionCalls).toEqual([]);
    expect(soulSyncCalls).toEqual([]);

    hostExecCalls = [];
    hostExecHandler = () => { throw new Error("pane missing"); };
    const missingOutput = await captureConsole(() => autoSave("tile-1", "work", { dryRun: true }));
    expect(hostExecCalls).toEqual(["tmux display-message -t 'work:tile-1' -p '#{pane_current_path}'"]);
    expect(missingOutput).toContain("would send /rrr to work:tile-1");
    expect(missingOutput).not.toContain("would git add + commit + push");
  });

  test("autoSave reports send, commit, push failures and swallows soul-sync failures", async () => {
    sendTextError = new Error("agent missing");
    soulSyncError = new Error("no peers");
    hostExecHandler = (command) => {
      if (command.includes("pane_current_path")) return "/repo/worktree\n";
      if (command.includes(" commit ")) throw new Error("nothing to save");
      if (command.endsWith(" push")) throw new Error("denied");
      return "";
    };

    let delays: number[] = [];
    const output = await captureConsole(async () => {
      delays = await withImmediateTimers(() => autoSave("tile-1", "work", {}));
    });

    expect(delays).toEqual([]);
    expect(sentTexts).toEqual([{ target: "work:tile-1", text: "/rrr" }]);
    expect(output).toContain("could not send /rrr");
    expect(output).toContain("nothing to commit");
    expect(output).toContain("push failed");
    expect(reunionCalls).toEqual(["tile-1"]);
    expect(soulSyncCalls).toEqual([{ target: undefined, opts: { cwd: "/repo/worktree" } }]);
  });

  test("autoSave reports git add failures and skips git entirely when pane cwd is unavailable", async () => {
    hostExecHandler = (command) => {
      if (command.includes("pane_current_path")) return "/repo/worktree\n";
      if (command.endsWith(" add -A")) throw new Error("add failed");
      return "";
    };
    const addOutput = await captureConsole(async () => {
      await withImmediateTimers(() => autoSave("tile-1", "work", {}));
    });
    expect(addOutput).toContain("git auto-save failed: add failed");
    expect(hostExecCalls.some((command) => command.includes(" commit "))).toBe(false);
    expect(hostExecCalls.some((command) => command.endsWith(" push"))).toBe(false);

    hostExecCalls = [];
    sentTexts = [];
    reunionCalls = [];
    soulSyncCalls = [];
    hostExecHandler = (command) => {
      if (command.includes("pane_current_path")) throw new Error("no pane");
      throw new Error(`unexpected git command: ${command}`);
    };

    const noPaneOutput = await captureConsole(async () => {
      await withImmediateTimers(() => autoSave("tile-2", "work", {}));
    });
    expect(hostExecCalls).toEqual(["tmux display-message -t 'work:tile-2' -p '#{pane_current_path}'"]);
    expect(sentTexts).toEqual([{ target: "work:tile-2", text: "/rrr" }]);
    expect(noPaneOutput).not.toContain("git auto-save in");
    expect(reunionCalls).toEqual(["tile-2"]);
    expect(soulSyncCalls).toEqual([{ target: undefined, opts: { cwd: "" } }]);
  });
});
