/** Targeted isolated coverage for src/vendor/mpr-plugins/workon/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let ghqFindResult: string | null = "/opt/Code/github.com/Soul-Brews-Studio/maw-js";
let worktrees: Array<{ path: string; name: string }> = [];
let hostExecCalls: string[] = [];
let hostExecFailures = new Map<string, Error>();
let newWindowCalls: Array<{ session: string; name: string; opts: unknown }> = [];
let sendTextCalls: Array<{ target: string; text: string }> = [];
let logs: string[] = [];
let errors: string[] = [];

const original = {
  log: console.log,
  error: console.error,
  tmux: process.env.TMUX,
  setTimeout,
};

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async (query: string) => {
    expect(query).toMatch(/^\//);
    return ghqFindResult;
  },
}));

mock.module("maw-js/config", () => ({
  buildCommand: (name: string) => `agent --name ${name}`,
}));

mock.module("maw-js/commands/shared/wake", () => ({
  findWorktrees: async (parentDir: string, repoName: string) => {
    expect(parentDir).toBe("/opt/Code/github.com/Soul-Brews-Studio");
    expect(repoName).toBe("maw-js");
    return worktrees;
  },
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    for (const [needle, error] of hostExecFailures) {
      if (cmd.includes(needle)) throw error;
    }
    if (cmd.includes("tmux display-message")) return "alpha-session\n";
    return "";
  },
  tmux: {
    newWindow: async (session: string, name: string, opts: unknown) => {
      newWindowCalls.push({ session, name, opts });
    },
    sendText: async (target: string, text: string) => {
      sendTextCalls.push({ target, text });
    },
  },
}));

const { cmdWorkon } = await import("../../src/vendor/mpr-plugins/workon/impl.ts?workon-plugin-coverage");

beforeEach(() => {
  ghqFindResult = "/opt/Code/github.com/Soul-Brews-Studio/maw-js";
  worktrees = [];
  hostExecCalls = [];
  hostExecFailures = new Map();
  newWindowCalls = [];
  sendTextCalls = [];
  logs = [];
  errors = [];
  process.env.TMUX = "/tmp/tmux-1000/default,1,0";
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
  console.log = original.log;
  console.error = original.error;
  globalThis.setTimeout = original.setTimeout;
});

describe("workon plugin coverage", () => {
  test("throws when the repo is not found", async () => {
    ghqFindResult = null;
    await expect(cmdWorkon("missing/repo")).rejects.toThrow("repo not found: missing/repo");
    expect(newWindowCalls).toEqual([]);
  });

  test("opens the repo in a new tmux window when no task is given", async () => {
    await cmdWorkon("Soul-Brews-Studio/maw-js");

    expect(hostExecCalls).toEqual(["tmux display-message -p '#{session_name}'"]);
    expect(newWindowCalls).toEqual([
      { session: "alpha-session", name: "maw-js", opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js" } },
    ]);
    expect(sendTextCalls).toEqual([{ target: "alpha-session:maw-js", text: "agent --name maw-js" }]);
    expect(logs.join("\n")).toContain("workon 'maw-js'");
  });

  test("reuses a matching worktree for task names", async () => {
    worktrees = [{ path: "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-2-fix-ci", name: "2-fix-ci" }];

    await cmdWorkon("maw-js", "fix");

    expect(hostExecCalls).toEqual(["tmux display-message -p '#{session_name}'"]);
    expect(newWindowCalls[0]).toEqual({
      session: "alpha-session",
      name: "maw-js-fix",
      opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-2-fix-ci" },
    });
    expect(logs.join("\n")).toContain("reusing worktree");
  });

  test("reports ambiguous worktree tasks", async () => {
    worktrees = [
      { path: "/repo.wt-1-pay-a", name: "1-pay-a" },
      { path: "/repo.wt-2-pay-b", name: "2-pay-b" },
    ];

    await expect(cmdWorkon("maw-js", "pay")).rejects.toThrow("'pay' is ambiguous");

    expect(errors.join("\n")).toContain("matches 2 worktrees");
    expect(newWindowCalls).toEqual([]);
  });

  test("creates a new numbered worktree and tolerates branch cleanup misses", async () => {
    worktrees = [{ path: "/repo.wt-7-old", name: "7-old" }];
    hostExecFailures.set("branch -D", new Error("branch not found"));

    await cmdWorkon("maw-js", "new-task");

    expect(hostExecCalls.some((cmd) => cmd.includes("branch -D 'agents/8-new-task'"))).toBe(true);
    expect(hostExecCalls.some((cmd) => cmd.includes("worktree add '/opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/8-new-task' -b 'agents/8-new-task'"))).toBe(true);
    expect(newWindowCalls[0]).toEqual({
      session: "alpha-session",
      name: "maw-js-new-task",
      opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/8-new-task" },
    });
    expect(sendTextCalls[0]).toEqual({ target: "alpha-session:maw-js-new-task", text: "agent --name maw-js-new-task" });
  });

  test("honors --layout legacy for new task worktrees", async () => {
    await cmdWorkon("maw-js", "legacy-task", { layout: "legacy" });

    expect(hostExecCalls.some((cmd) => cmd.includes("worktree add '/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-1-legacy-task' -b 'agents/1-legacy-task'"))).toBe(true);
    expect(newWindowCalls[0]).toEqual({
      session: "alpha-session",
      name: "maw-js-legacy-task",
      opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-1-legacy-task" },
    });
  });

  test("requires tmux and a detectable current session", async () => {
    delete process.env.TMUX;
    await expect(cmdWorkon("maw-js")).rejects.toThrow("not in a tmux session");

    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    hostExecFailures.set("tmux display-message", new Error("no tmux"));
    await expect(cmdWorkon("maw-js")).rejects.toThrow("could not detect current tmux session");
  });
});
