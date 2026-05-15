/**
 * done-all.test.ts — #1380 regression guard.
 *
 * `maw done --all` batches the existing single-window done lifecycle across
 * the current tmux session, but it must never target the lead window or a
 * same-named window from another session.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

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

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  get FLEET_DIR() { return "/tmp/maw-test-fleet"; },
  takeSnapshot: async (trigger: string) => { snapshots.push(trigger); return "/tmp/snapshot.json"; },
  tmux: {
    run: async (subcommand: string, ...args: string[]) => {
      tmuxCommands.push(["run", subcommand, ...args].join(" "));
      if (tmuxRunFails) throw new Error("no current tmux session");
      if (subcommand === "display-message") return `${currentSession}\n`;
      return "";
    },
    killWindow: async (target: string) => {
      tmuxCommands.push(`kill ${target}`);
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
  signalParentInbox: async (windowName: string, sessionName: string) => {
    inboxSignals.push({ windowName, sessionName });
  },
  autoSave: async (windowName: string, sessionName: string, opts: { dryRun?: boolean }) => {
    autoSaveCalls.push({ windowName, sessionName, dryRun: opts.dryRun });
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
}));

const { cmdDoneAll } = await import("../../src/vendor/mpr-plugins/done/impl");
const donePlugin = await import("../../src/vendor/mpr-plugins/done/index");

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
});
