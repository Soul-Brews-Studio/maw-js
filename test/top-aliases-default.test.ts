import { describe, expect, test } from "bun:test";
import {
  ALIAS_DESCRIPTIONS,
  invokeDirectHandler,
  parseBringArgs,
  parseLsAliasOpts,
  resolveTopAlias,
  type TopAliasHandlerDeps,
} from "../src/cli/top-aliases";
import { UserError } from "../src/core/util/user-error";

function makeDeps() {
  const calls = {
    tmuxLs: [] as unknown[],
    wake: [] as unknown[][],
    new: [] as unknown[][],
    preflight: [] as unknown[],
    loadConfig: 0,
    logs: [] as string[],
    errors: [] as string[],
  };
  const deps: TopAliasHandlerDeps = {
    cmdTmuxLs: async (opts) => { calls.tmuxLs.push(opts); },
    cmdWake: async (...args) => { calls.wake.push(args); },
    cmdNew: async (...args) => { calls.new.push(args); },
    cmdPreflight: async (opts) => { calls.preflight.push(opts); },
    loadConfig: () => {
      calls.loadConfig += 1;
      return { commands: { codex: "codex", spark: "spark" } };
    },
    log: (line) => { calls.logs.push(line); },
    error: (line) => { calls.errors.push(line); },
  };
  return { calls, deps };
}

describe("top alias resolution table", () => {
  test("empty, blank, and unknown argv do not resolve", () => {
    expect(resolveTopAlias([])).toBeNull();
    expect(resolveTopAlias([""])).toBeNull();
    expect(resolveTopAlias(["unknown"])).toBeNull();
  });

  test("argv rewrite aliases preserve remaining argv", () => {
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
      expect(resolveTopAlias(input)).toEqual({ kind: "argv", argv: expected });
    }
    expect(ALIAS_DESCRIPTIONS.cleanup).toContain("zombie");
    expect(ALIAS_DESCRIPTIONS.bring).toContain("Bring");
  });

  test("direct aliases return handler specs and trimmed argv", () => {
    expect(resolveTopAlias(["ls", "-v"])).toEqual({ kind: "direct", handler: "cmdLs", argv: ["-v"] });
    expect(resolveTopAlias(["bring", "neo"])).toEqual({
      kind: "direct",
      handler: "../commands/shared/wake-cmd:cmdBring",
      argv: ["neo"],
    });
    expect(resolveTopAlias(["b", "neo"])).toEqual({
      kind: "direct",
      handler: "../commands/shared/wake-cmd:cmdBring",
      argv: ["neo"],
    });
    expect(resolveTopAlias(["wake", "neo"])).toEqual({
      kind: "direct",
      handler: "../commands/shared/wake-cmd:cmdWake",
      argv: ["neo"],
    });
    expect(resolveTopAlias(["awake", "neo"])).toEqual({
      kind: "direct",
      handler: "../commands/shared/wake-cmd:cmdAwake",
      argv: ["neo"],
    });
    expect(resolveTopAlias(["new", "workspace"])).toEqual({
      kind: "direct",
      handler: "./cmd-new:cmdNew",
      argv: ["workspace"],
    });
    expect(resolveTopAlias(["preflight", "--fix"])).toEqual({
      kind: "direct",
      handler: "../commands/shared/preflight:cmdPreflight",
      argv: ["--fix"],
    });
  });
});

describe("top alias option parsers", () => {
  test("ls opts cover compact defaults, verbose, roster, json, and recent limits", () => {
    expect(parseLsAliasOpts([])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: false,
      json: false,
    });
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
    expect(parseLsAliasOpts(["-v"])).toEqual({
      all: true,
      compact: false,
      verbose: true,
      roster: false,
      json: false,
    });
  });

  test("bring opts default to split, let tab win, and reject missing oracle", () => {
    expect(parseBringArgs(["neo", "--tab", "--split", "-e", "codex"])).toEqual({
      oracle: "neo",
      opts: { bring: true, tab: true, engine: "codex" },
    });
    expect(parseBringArgs(["neo"])).toEqual({ oracle: "neo", opts: { split: true } });

    const errors: string[] = [];
    expect(() => parseBringArgs(["--tab"], (line) => errors.push(line))).toThrow(UserError);
    expect(errors.join("\n")).toContain("usage: maw bring");
  });
});

describe("direct handler invocation", () => {
  test("cmdLs dispatches parsed options to tmux ls", async () => {
    const { calls, deps } = makeDeps();

    await invokeDirectHandler("cmdLs", ["--json", "-r", "5", "-v"], deps);

    expect(calls.tmuxLs).toEqual([{
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
    const { calls, deps } = makeDeps();

    await invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", ["--help"], deps);

    expect(calls.wake).toEqual([]);
    expect(calls.logs.join("\n")).toContain("usage: maw wake");
  });

  test("wake parses full option surface including engine shorthand", async () => {
    const { calls, deps } = makeDeps();

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
    ], deps);

    expect(calls.loadConfig).toBe(1);
    expect(calls.wake).toEqual([["neo", {
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

  test("awake supports help and explicit engine without loading config", async () => {
    const { calls, deps } = makeDeps();

    await invokeDirectHandler("../commands/shared/wake-cmd:cmdAwake", ["--help"], deps);
    expect(calls.logs.join("\n")).toContain("usage: maw awake");
    expect(calls.logs.join("\n")).toContain("Does not send /awaken");

    calls.logs = [];
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdAwake", ["neo", "--engine", "spark"], deps);
    expect(calls.loadConfig).toBe(0);
    expect(calls.wake).toEqual([["neo", { engine: "spark" }]]);
  });

  test("wake missing oracle prints usage and throws UserError", async () => {
    const { calls, deps } = makeDeps();

    await expect(invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", ["--dry-run"], deps)).rejects.toThrow(UserError);

    expect(calls.errors.join("\n")).toContain("usage: maw wake");
    expect(calls.wake).toEqual([]);
  });

  test("bring help and direct invocation route through cmdWake", async () => {
    const { calls, deps } = makeDeps();

    await invokeDirectHandler("../commands/shared/wake-cmd:cmdBring", ["--help"], deps);
    expect(calls.logs.join("\n")).toContain("usage: maw bring");

    calls.logs = [];
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdBring", ["neo", "--tab", "-e", "codex"], deps);
    expect(calls.wake).toEqual([["neo", { bring: true, tab: true, engine: "codex" }]]);
  });

  test("new and preflight handlers dispatch to their static imports", async () => {
    const { calls, deps } = makeDeps();

    await invokeDirectHandler("./cmd-new:cmdNew", ["workspace", "--no-attach"], deps);
    await invokeDirectHandler("../commands/shared/preflight:cmdPreflight", ["--fix"], deps);
    await invokeDirectHandler("../commands/shared/preflight:cmdPreflight", [], deps);

    expect(calls.new).toEqual([[["workspace", "--no-attach"]]]);
    expect(calls.preflight).toEqual([{ fix: true }, { fix: false }]);
  });

  test("malformed and unknown direct handlers fail loudly", async () => {
    await expect(invokeDirectHandler("module:", [])).rejects.toThrow("malformed handler spec");
    await expect(invokeDirectHandler("cmdNope", [])).rejects.toThrow("unknown direct-handler export");
  });
});
