/** Targeted isolated coverage for src/vendor/mpr-plugins/workon/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let ghqFindResult: string | null = "/opt/Code/github.com/Soul-Brews-Studio/maw-js";
let worktrees: Array<{ path: string; name: string }> = [];
let hostExecCalls: string[] = [];
let hostExecFailures = new Map<string, Error>();
let newWindowCalls: Array<{ session: string; name: string; opts: unknown }> = [];
let sendTextCalls: Array<{ target: string; text: string }> = [];
let listWindowsReturn: Array<{ index: number; name: string; active: boolean }> = [];
let selectWindowCalls: string[] = [];
let ensureFleetCalls: Array<{ session: string; window: string; cwd?: string; createdBy: string }> = [];
let ensureFleetResult: { status: string } = { status: "created" };
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

mock.module("maw-js/commands/shared/fleet-ensure", () => ({
  ensureFleetSessionEntry: (input: { session: string; window: string; cwd?: string; createdBy: string }) => {
    ensureFleetCalls.push(input);
    return ensureFleetResult;
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
    listWindows: async (_session: string) => listWindowsReturn,
    selectWindow: async (target: string) => {
      selectWindowCalls.push(target);
    },
    newWindow: async (session: string, name: string, opts: unknown) => {
      newWindowCalls.push({ session, name, opts });
    },
    sendText: async (target: string, text: string) => {
      sendTextCalls.push({ target, text });
    },
  },
}));

const { cmdWorkon, sanitizeWorkonTaskSlug } = await import("../../src/vendor/mpr-plugins/workon/impl.ts?workon-plugin-coverage");

beforeEach(() => {
  ghqFindResult = "/opt/Code/github.com/Soul-Brews-Studio/maw-js";
  worktrees = [];
  hostExecCalls = [];
  hostExecFailures = new Map();
  newWindowCalls = [];
  sendTextCalls = [];
  listWindowsReturn = [];
  selectWindowCalls = [];
  ensureFleetCalls = [];
  ensureFleetResult = { status: "created" };
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

  test("#2571 — reuses an existing window of the same name (no duplicate)", async () => {
    listWindowsReturn = [{ index: 1, name: "maw-js", active: false }];

    await cmdWorkon("Soul-Brews-Studio/maw-js");

    // Selects the live window and returns — no second window, no second agent.
    expect(selectWindowCalls).toEqual(["alpha-session:maw-js"]);
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
    expect(logs.join("\n")).toContain("already open");
  });

  test("#2571 — still creates the window when only a different name is open", async () => {
    listWindowsReturn = [{ index: 1, name: "some-other-window", active: true }];

    await cmdWorkon("Soul-Brews-Studio/maw-js");

    expect(selectWindowCalls).toEqual([]);
    expect(newWindowCalls).toEqual([
      { session: "alpha-session", name: "maw-js", opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js" } },
    ]);
  });

  test("#2571 — dedups a task window by its full <repo>-<task> name", async () => {
    worktrees = [{ path: "/opt/Code/github.com/Soul-Brews-Studio/maw-js.wt-2-fix-ci", name: "2-fix-ci" }];
    listWindowsReturn = [{ index: 3, name: "maw-js-fix", active: false }];

    await cmdWorkon("maw-js", "fix");

    expect(selectWindowCalls).toEqual(["alpha-session:maw-js-fix"]);
    expect(newWindowCalls).toEqual([]);
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

  test("sanitizes slash-separated task names before resolving paths and branches", async () => {
    expect(sanitizeWorkonTaskSlug("feat/message-tracking")).toBe("feat-message-tracking");
    hostExecFailures.set("branch -D", new Error("branch not found"));

    await cmdWorkon("maw-js", "feat/message-tracking");

    expect(hostExecCalls.some((cmd) => cmd.includes("branch -D 'agents/1-feat-message-tracking'"))).toBe(true);
    expect(hostExecCalls.some((cmd) => cmd.includes("worktree add '/opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/1-feat-message-tracking' -b 'agents/1-feat-message-tracking'"))).toBe(true);
    expect(newWindowCalls[0]).toEqual({
      session: "alpha-session",
      name: "maw-js-feat-message-tracking",
      opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/1-feat-message-tracking" },
    });
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

  test("#2572 — auto-registers an oracle-repo window in the fleet", async () => {
    ghqFindResult = "/opt/Code/github.com/laris-co/neo-oracle";

    await cmdWorkon("laris-co/neo-oracle");

    expect(ensureFleetCalls).toEqual([
      { session: "alpha-session", window: "neo-oracle", cwd: "/opt/Code/github.com/laris-co/neo-oracle", createdBy: "maw workon" },
    ]);
    expect(logs.join("\n")).toContain("fleet registered alpha-session:neo-oracle");
  });

  test("#2572 — does NOT register a non-oracle repo window", async () => {
    // default ghqFindResult is .../maw-js (no -oracle suffix)
    await cmdWorkon("Soul-Brews-Studio/maw-js");

    expect(ensureFleetCalls).toEqual([]);
    expect(logs.join("\n")).not.toContain("fleet registered");
  });

  test("#2572 — registers but stays quiet when the entry already exists", async () => {
    ghqFindResult = "/opt/Code/github.com/laris-co/neo-oracle";
    ensureFleetResult = { status: "exists" };

    await cmdWorkon("laris-co/neo-oracle");

    expect(ensureFleetCalls.length).toBe(1);
    expect(logs.join("\n")).not.toContain("fleet registered");
  });

  test("#2572 — does not register when an existing window is reused", async () => {
    ghqFindResult = "/opt/Code/github.com/laris-co/neo-oracle";
    listWindowsReturn = [{ index: 1, name: "neo-oracle", active: false }];

    await cmdWorkon("laris-co/neo-oracle");

    // #2571 dedup returns early — no new window, and nothing to register.
    expect(selectWindowCalls).toEqual(["alpha-session:neo-oracle"]);
    expect(newWindowCalls).toEqual([]);
    expect(ensureFleetCalls).toEqual([]);
  });
});
