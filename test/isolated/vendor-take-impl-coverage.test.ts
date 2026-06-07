import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Session = { name: string; windows: Array<{ index: number; name: string }> };

let sessions: Session[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> = async () => "";
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecImpl(cmd);
  },
  tmux: {},
}));

mock.module("maw-js/config", () => ({
  buildCommandInDir: () => "unused",
}));

const { cmdTake } = await import("../../src/vendor/mpr-plugins/take/impl.ts?vendor-take-impl-coverage");

beforeEach(() => {
  sessions = [{ name: "neo", windows: [{ index: 2, name: "skills" }] }];
  hostExecCalls = [];
  hostExecImpl = async (cmd: string) => cmd.includes("display-message") ? "/repos/neo\n" : "";
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("vendor take impl coverage", () => {
  test("requires a source window in session:window form", async () => {
    await expect(cmdTake("neo")).rejects.toThrow("usage: maw take <session>:<window>");
    expect(errors.join("\n")).toContain("usage: maw take <session>:<window>");
    expect(hostExecCalls).toEqual([]);
  });

  test("creates a split target, ignores duplicate session, moves by window name, and prints cwd", async () => {
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("new-session")) throw new Error("duplicate session: skills");
      if (cmd.includes("display-message")) return "/repos/neo\n";
      return "";
    };

    await cmdTake("neo:skills");

    expect(hostExecCalls[0]).toContain("tmux new-session -d -s 'skills'");
    expect(hostExecCalls).toContain("tmux display-message -t 'neo:skills' -p '#{pane_current_path}'");
    expect(hostExecCalls).toContain("tmux move-window -s 'neo:skills' -t 'skills:'");
    expect(hostExecCalls).toContain("tmux kill-window -t 'skills:1' 2>/dev/null");
    expect(logs.join("\n")).toContain("neo:skills → skills (new session)");
    expect(logs.join("\n")).toContain("cwd: /repos/neo");
  });

  test("wraps split session creation failures that are not duplicates", async () => {
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("new-session")) throw new Error("permission denied");
      return "";
    };

    await expect(cmdTake("neo:skills")).rejects.toThrow("could not create session 'skills': permission denied");
  });

  test("returns early when source and target sessions are the same", async () => {
    await cmdTake("neo:skills", "neo");

    expect(logs.join("\n")).toContain("source and target are the same session");
    expect(hostExecCalls).toEqual([]);
  });

  test("reports missing source sessions and missing source windows", async () => {
    sessions = [];
    await expect(cmdTake("neo:skills", "pulse")).rejects.toThrow("session 'neo' not found");

    sessions = [{ name: "neo", windows: [{ index: 1, name: "main" }] }];
    await expect(cmdTake("neo:skills", "pulse")).rejects.toThrow("window 'skills' not found in session 'neo'");
  });

  test("moves by numeric window index, tolerates cwd and kill-window failures, and wraps move errors", async () => {
    sessions = [{ name: "Neo", windows: [{ index: 2, name: "skills" }] }];
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("display-message")) throw new Error("pane gone");
      if (cmd.includes("kill-window")) throw new Error("default gone");
      return "";
    };

    await cmdTake("neo:2");
    expect(hostExecCalls).toContain("tmux move-window -s 'Neo:skills' -t '2:'");
    expect(logs.join("\n")).toContain("Neo:skills → 2 (new session)");
    expect(logs.join("\n")).not.toContain("cwd:");

    hostExecCalls = [];
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("move-window")) throw new Error("no target");
      return "";
    };
    await expect(cmdTake("neo:skills", "pulse")).rejects.toThrow("move failed: no target");
  });
});
