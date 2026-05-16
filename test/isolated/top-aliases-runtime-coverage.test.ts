/**
 * Runtime coverage for top-level CLI alias dispatch. Static handler imports are
 * mocked in an isolated Bun process so direct-handler paths can be exercised
 * without touching tmux, wake, preflight, or workspace creation.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { UserError } from "../../src/core/util/user-error";

let tmuxLsCalls: unknown[] = [];
let wakeCalls: unknown[][] = [];
let newCalls: unknown[][] = [];
let preflightCalls: unknown[] = [];
let loadConfigCalls = 0;
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxLs: async (opts: unknown) => { tmuxLsCalls.push(opts); },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (...args: unknown[]) => { wakeCalls.push(args); },
}));

mock.module(import.meta.resolve("../../src/cli/cmd-new"), () => ({
  cmdNew: async (...args: unknown[]) => { newCalls.push(args); },
}));

mock.module(import.meta.resolve("../../src/commands/shared/preflight"), () => ({
  cmdPreflight: async (opts: unknown) => { preflightCalls.push(opts); },
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  loadConfig: () => {
    loadConfigCalls += 1;
    return { commands: { codex: "codex", spark: "spark" } };
  },
}));

const {
  ALIAS_DESCRIPTIONS,
  invokeDirectHandler,
  parseBringArgs,
  parseLsAliasOpts,
  resolveTopAlias,
} = await import("../../src/cli/top-aliases.ts?top-aliases-runtime-coverage");

beforeEach(() => {
  tmuxLsCalls = [];
  wakeCalls = [];
  newCalls = [];
  preflightCalls = [];
  loadConfigCalls = 0;
  logs = [];
  errors = [];
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
  console.error = (line?: unknown) => { errors.push(String(line ?? "")); };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("top alias resolution table", () => {
  test("empty argv and blank verbs do not resolve", () => {
    expect(resolveTopAlias([])).toBeNull();
    expect(resolveTopAlias([""])).toBeNull();
    expect(resolveTopAlias(["unknown"])).toBeNull();
  });

  test("argv rewrite aliases preserve the remaining argv exactly", () => {
    const cases: Array<[string[], string[]]> = [
      [["A", "neo"], ["tmux", "attach", "neo"]],
      [["kill", "pane"], ["tmux", "kill", "pane"]],
      [["split", "target"], ["split", "target"]],
      [["open", "target"], ["tmux", "open", "target"]],
      [["close", "target"], ["tmux", "close", "target"]],
      [["t", "send"], ["team", "send"]],
      [["layout", "tiled"], ["team", "layout", "tiled"]],
      [["zoom", "42"], ["tmux", "zoom", "42"]],
      [["panes"], ["tmux", "ls", "--all", "--verbose"]],
      [["cleanup"], ["team", "cleanup", "--zombie-agents"]],
      [["tile", "4"], ["tile", "4"]],
      [["scaffold", "neo"], ["bud", "--scaffold-only", "neo"]],
      [["snapshots", "list"], ["fleet", "snapshots", "list"]],
    ];

    for (const [input, expected] of cases) {
      const out = resolveTopAlias(input);
      expect(out).toEqual({ kind: "argv", argv: expected });
    }
    expect(ALIAS_DESCRIPTIONS.cleanup).toContain("zombie");
  });
});

describe("top alias option parsers", () => {
  test("ls opts handle json, roster, recent limits, and compact precedence", () => {
    expect(parseLsAliasOpts(["--json", "--all", "--recent", "12", "--compact", "--verbose"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: true,
      json: true,
      recent: true,
      recentLimit: 12,
    });
    expect(parseLsAliasOpts(["--recent", "0"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: false,
      json: false,
      recent: true,
    });
  });

  test("bring opts default to split, let --tab win, and reject missing oracle", () => {
    expect(parseBringArgs(["neo", "--tab", "--split", "-e", "codex"])).toEqual({
      oracle: "neo",
      opts: { bring: true, tab: true, engine: "codex" },
    });
    expect(() => parseBringArgs(["--tab"])).toThrow(UserError);
    expect(errors.join("\n")).toContain("usage: maw bring");
  });
});

describe("direct handler invocation", () => {
  test("cmdLs dispatches parsed ls options to tmux ls", async () => {
    await invokeDirectHandler("cmdLs", ["--json", "-r", "5", "-v"]);
    expect(tmuxLsCalls).toEqual([{
      all: true,
      compact: false,
      verbose: true,
      roster: false,
      json: true,
      recent: true,
      recentLimit: 5,
    }]);
  });

  test("wake help prints usage without invoking wake", async () => {
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", ["--help"]);
    expect(wakeCalls).toEqual([]);
    expect(logs.join("\n")).toContain("usage: maw wake");
  });

  test("wake parses full option surface including engine shorthand", async () => {
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", [
      "neo",
      "--task", "fix bug",
      "--wt", "issue-1",
      "--session", "workspace",
      "-p", "hello",
      "--incubate", "Soul-Brews-Studio/maw-js",
      "--fresh",
      "--bud",
      "--signal-on-birth",
      "-a",
      "--list",
      "--dry-run",
      "--snapshot", "snap-1",
      "--solo",
      "--split",
      "--all-local",
      "--codex",
    ]);

    expect(loadConfigCalls).toBe(1);
    expect(wakeCalls).toEqual([["neo", {
      task: "fix bug",
      wt: "issue-1",
      session: "workspace",
      prompt: "hello",
      incubate: "Soul-Brews-Studio/maw-js",
      fresh: true,
      bud: true,
      signalOnBirth: true,
      attach: true,
      listWt: true,
      dryRun: true,
      fromSnapshot: true,
      snapshotId: "snap-1",
      noRehydrate: true,
      split: true,
      allLocal: true,
      engine: "codex",
    }]]);
  });

  test("awake supports help and explicit engine without awakening ritual", async () => {
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdAwake", ["--help"]);
    expect(logs.join("\n")).toContain("usage: maw awake");
    expect(logs.join("\n")).toContain("Does not send /awaken");

    logs = [];
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdAwake", ["neo", "--engine", "spark"]);
    expect(wakeCalls).toEqual([["neo", { engine: "spark" }]]);
  });

  test("wake missing oracle prints usage and throws UserError", async () => {
    await expect(invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", ["--dry-run"])).rejects.toThrow(UserError);
    expect(errors.join("\n")).toContain("usage: maw wake");
    expect(wakeCalls).toEqual([]);
  });

  test("bring help and direct invocation route through cmdWake", async () => {
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdBring", ["--help"]);
    expect(logs.join("\n")).toContain("usage: maw bring");

    logs = [];
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdBring", ["neo", "--tab", "-e", "codex"]);
    expect(wakeCalls).toEqual([["neo", { bring: true, tab: true, engine: "codex" }]]);
  });

  test("new and preflight handlers dispatch to their static imports", async () => {
    await invokeDirectHandler("./cmd-new:cmdNew", ["workspace", "--no-attach"]);
    await invokeDirectHandler("../commands/shared/preflight:cmdPreflight", ["--fix"]);
    await invokeDirectHandler("../commands/shared/preflight:cmdPreflight", []);

    expect(newCalls).toEqual([[["workspace", "--no-attach"]]]);
    expect(preflightCalls).toEqual([{ fix: true }, { fix: false }]);
  });

  test("malformed and unknown direct handlers fail loudly", async () => {
    await expect(invokeDirectHandler("module:", [])).rejects.toThrow("malformed handler spec");
    await expect(invokeDirectHandler("cmdNope", [])).rejects.toThrow("unknown direct-handler export");
  });
});
