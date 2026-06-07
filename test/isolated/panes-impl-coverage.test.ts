/** Targeted isolated coverage for src/vendor/mpr-plugins/panes/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Session = { name: string };
type ResolveResult =
  | { kind: "match"; match: Session }
  | { kind: "ambiguous"; candidates: Session[] }
  | { kind: "none"; hints?: Session[] };

let sessions: Session[] = [];
let resolveResults = new Map<string, ResolveResult>();
let resolveCalls: Array<{ target: string; sessions: Session[] }> = [];
let listSessionsCalls = 0;
let hostExecCalls: string[] = [];
let hostExecOutput = "";
let hostExecFailure: unknown = null;
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/sdk", () => ({
  listSessions: async () => {
    listSessionsCalls += 1;
    return sessions;
  },
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (hostExecFailure) throw hostExecFailure;
    return hostExecOutput;
  },
  tmuxCmd: () => "tmux",
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (target: string, seenSessions: Session[]) => {
    resolveCalls.push({ target, sessions: seenSessions });
    return resolveResults.get(target) ?? { kind: "none", hints: [] };
  },
}));

const { cmdPanes } = await import("../../src/vendor/mpr-plugins/panes/impl.ts?panes-impl-coverage");

function stdout(): string {
  return logs.join("\n");
}

function stderr(): string {
  return errors.join("\n");
}

beforeEach(() => {
  sessions = [];
  resolveResults = new Map();
  resolveCalls = [];
  listSessionsCalls = 0;
  hostExecCalls = [];
  hostExecOutput = "";
  hostExecFailure = null;
  logs = [];
  errors = [];
  console.log = (line?: unknown) => {
    logs.push(String(line ?? ""));
  };
  console.error = (line?: unknown) => {
    errors.push(String(line ?? ""));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("panes impl isolated coverage", () => {
  test("lists current tmux panes with default columns and renders empty output", async () => {
    hostExecOutput = [
      "work:0.0|||80x24|||zsh|||main",
      "work:0.1|||120x30|||vim|||",
    ].join("\n");

    await cmdPanes();

    expect(listSessionsCalls).toBe(0);
    expect(resolveCalls).toEqual([]);
    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toBe("tmux list-panes  -F '#{session_name}:#{window_index}.#{pane_index}|||#{pane_width}x#{pane_height}|||#{pane_current_command}|||#{pane_title}'");
    expect(stdout()).toContain("TARGET");
    expect(stdout()).toContain("SIZE");
    expect(stdout()).toContain("COMMAND");
    expect(stdout()).toContain("work:0.0");
    expect(stdout()).toContain("80x24");
    expect(stdout()).toContain("zsh");
    expect(stdout()).toContain("main");
    expect(stdout()).toContain("work:0.1");
    expect(stdout()).toContain("vim");

    logs = [];
    hostExecCalls = [];
    hostExecOutput = "";
    await cmdPanes();

    expect(hostExecCalls[0]).toContain("tmux list-panes  -F");
    expect(stdout()).toContain("(no panes)");
  });

  test("--all warns when given a target and skips target resolution", async () => {
    sessions = [{ name: "ignored" }];
    resolveResults.set("ignored", { kind: "match", match: { name: "should-not-resolve" } });
    hostExecOutput = "other:3.4|||90x40|||node|||remote";

    await cmdPanes("ignored", { all: true });

    expect(listSessionsCalls).toBe(0);
    expect(resolveCalls).toEqual([]);
    expect(hostExecCalls).toEqual([
      "tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}|||#{pane_width}x#{pane_height}|||#{pane_current_command}|||#{pane_title}'",
    ]);
    expect(stdout()).toContain("--all ignores target argument");
    expect(stdout()).toContain("other:3.4");
    expect(stdout()).toContain("remote");
  });

  test("resolves bare sessions and includes pid columns when requested", async () => {
    sessions = [{ name: "alpha-main" }, { name: "beta" }];
    resolveResults.set("alpha", { kind: "match", match: { name: "alpha-main" } });
    hostExecOutput = [
      "alpha-main:0.0|||100x20|||bash|||console|||4321",
      "alpha-main:1.2|||120x50|||bun|||tests|||9876",
    ].join("\n");

    await cmdPanes("alpha", { pid: true });

    expect(listSessionsCalls).toBe(1);
    expect(resolveCalls).toEqual([{ target: "alpha", sessions }]);
    expect(hostExecCalls).toEqual([
      "tmux list-panes -s -t 'alpha-main' -F '#{session_name}:#{window_index}.#{pane_index}|||#{pane_width}x#{pane_height}|||#{pane_current_command}|||#{pane_title}|||#{pane_pid}'",
    ]);
    expect(stdout()).toContain("PID");
    expect(stdout()).toContain("4321");
    expect(stdout()).toContain("9876");
    expect(stdout()).toContain("tests");
  });

  test("resolves session portions of window targets", async () => {
    sessions = [{ name: "dev-full" }];
    resolveResults.set("dev", { kind: "match", match: { name: "dev-full" } });
    hostExecOutput = "dev-full:2.1|||88x33|||fish|||editor";

    await cmdPanes("dev:2.1");

    expect(resolveCalls).toEqual([{ target: "dev", sessions }]);
    expect(hostExecCalls).toEqual([
      "tmux list-panes -s -t 'dev-full:2.1' -F '#{session_name}:#{window_index}.#{pane_index}|||#{pane_width}x#{pane_height}|||#{pane_current_command}|||#{pane_title}'",
    ]);
    expect(stdout()).toContain("dev-full:2.1");
    expect(stdout()).toContain("editor");
  });

  test("reports ambiguous and missing targets before spawning tmux list-panes", async () => {
    sessions = [{ name: "dev-one" }, { name: "dev-two" }, { name: "hinted" }];
    resolveResults.set("dev", {
      kind: "ambiguous",
      candidates: [{ name: "dev-one" }, { name: "dev-two" }],
    });

    await expect(cmdPanes("dev:1")).rejects.toThrow("'dev' is ambiguous — matches 2 sessions");
    expect(stderr()).toContain("'dev' is ambiguous");
    expect(stderr()).toContain("dev-one");
    expect(stderr()).toContain("dev-two");
    expect(hostExecCalls).toEqual([]);

    errors = [];
    resolveResults.set("ghost", { kind: "none", hints: [{ name: "hinted" }] });
    await expect(cmdPanes("ghost")).rejects.toThrow("session 'ghost' not found");
    expect(stderr()).toContain("did you mean");
    expect(stderr()).toContain("hinted");
    expect(hostExecCalls).toEqual([]);

    errors = [];
    resolveResults.set("windowless", { kind: "none", hints: [{ name: "window-hint" }] });
    await expect(cmdPanes("windowless:2")).rejects.toThrow("session 'windowless' not found");
    expect(stderr()).toContain("did you mean");
    expect(stderr()).toContain("window-hint");
    expect(hostExecCalls).toEqual([]);

    errors = [];
    resolveResults.set("bare-ambiguous", {
      kind: "ambiguous",
      candidates: [{ name: "bare-one" }, { name: "bare-two" }],
    });
    await expect(cmdPanes("bare-ambiguous")).rejects.toThrow("'bare-ambiguous' is ambiguous — matches 2 sessions");
    expect(stderr()).toContain("bare-one");
    expect(stderr()).toContain("bare-two");
    expect(hostExecCalls).toEqual([]);

    errors = [];
    resolveResults.set("absent", { kind: "none", hints: [] });
    await expect(cmdPanes("absent")).rejects.toThrow("session 'absent' not found");
    expect(stderr()).toContain("try: maw ls");
    expect(hostExecCalls).toEqual([]);
  });

  test("wraps hostExec failures with list-panes context", async () => {
    hostExecFailure = new Error("tmux exploded");

    await expect(cmdPanes()).rejects.toThrow("list-panes failed: tmux exploded");
    expect(hostExecCalls).toHaveLength(1);
  });
});
