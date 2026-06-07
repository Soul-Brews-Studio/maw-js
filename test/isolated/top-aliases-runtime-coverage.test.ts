/**
 * Runtime coverage for top-level CLI alias dispatch. Static handler imports are
 * mocked in an isolated Bun process so direct-handler paths can be exercised
 * without touching tmux, wake, preflight, or workspace creation.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { UserError } from "../../src/core/util/user-error";

let tmuxLsCalls: unknown[] = [];
let tmuxLayoutCalls: unknown[][] = [];
let wakeCalls: unknown[][] = [];
let newCalls: unknown[][] = [];
let preflightCalls: unknown[] = [];
let lsFederatedCalls: unknown[] = [];
let loadConfigCalls = 0;
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => {
  const parseActiveDurationSeconds = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const match = /^(\d+)([smhd])?$/.exec(raw.trim().toLowerCase());
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    const unit = match[2] ?? "m";
    return value * (unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400);
  };
  return {
    activeDurationArg: (argv: string[]) => {
      const index = argv.indexOf("--active");
      const next = index >= 0 ? argv[index + 1] : undefined;
      return next && !next.startsWith("-") && parseActiveDurationSeconds(next) ? next : undefined;
    },
    cmdTmuxLs: async (opts: unknown) => { tmuxLsCalls.push(opts); },
    cmdTmuxLayout: async (...args: unknown[]) => { tmuxLayoutCalls.push(args); },
    parseActiveDurationSeconds,
  };
});

mock.module(import.meta.resolve("../../src/commands/shared/wake-cmd"), () => ({
  cmdWake: async (...args: unknown[]) => { wakeCalls.push(args); },
}));

mock.module(import.meta.resolve("../../src/cli/cmd-new"), () => ({
  cmdNew: async (...args: unknown[]) => { newCalls.push(args); },
}));

mock.module(import.meta.resolve("../../src/commands/shared/preflight"), () => ({
  cmdPreflight: async (opts: unknown) => { preflightCalls.push(opts); },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/ls/internal/peer-call"), () => ({
  lsFederated: async (opts: unknown) => {
    lsFederatedCalls.push(opts);
    return { ok: true, output: "federated output" };
  },
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
  tmuxLayoutCalls = [];
  wakeCalls = [];
  newCalls = [];
  preflightCalls = [];
  lsFederatedCalls = [];
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
      [["A", "neo"], ["attach", "neo"]],
      [["kill", "pane"], ["tmux", "kill", "pane"]],
      [["split", "target"], ["split", "target"]],
      [["open", "target"], ["tmux", "open", "target"]],
      [["close", "target"], ["tmux", "close", "target"]],
      [["t", "send"], ["team", "send"]],
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
    expect(ALIAS_DESCRIPTIONS.layout).toContain("current window");
  });

  test("layout is a direct top-level handler, not a team argv alias", () => {
    expect(resolveTopAlias(["layout", "tiled"])).toEqual({ kind: "direct", handler: "cmdLayout", argv: ["tiled"] });
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
      channels: true,
      recent: true,
      recentLimit: 12,
    });
    expect(parseLsAliasOpts(["--recent", "0"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: false,
      json: false,
      oracleOnly: true,
      recent: true,
    });
    expect(parseLsAliasOpts(["--active", "1h", "alpha"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: false,
      json: false,
      filter: "alpha",
      oracleOnly: true,
      active: true,
      activeThresholdSec: 3600,
    });
  });

  test("ls opts parse node filters, positional filters, and channel opt-in", () => {
    expect(parseLsAliasOpts(["--node", "alpha"])).toMatchObject({ filter: "alpha" });
    expect(parseLsAliasOpts(["alpha"])).toMatchObject({ filter: "alpha" });
    expect(parseLsAliasOpts(["--channels"])).toMatchObject({ channels: true });
    expect(parseLsAliasOpts(["--federation"])).toMatchObject({ federation: true });
  });

  test("bring opts default to split and reject missing oracle", () => {
    expect(parseBringArgs(["neo", "--tab", "--split", "-e", "codex"])).toEqual({
      oracle: "neo",
      opts: { split: true, engine: "codex" },
    });
    expect(() => parseBringArgs(["--tab"])).toThrow(UserError);
    expect(errors.join("\n")).toContain("usage: maw bring");
  });
});

describe("direct handler invocation", () => {
  test("cmdLs dispatches parsed default ls options to local tmux ls", async () => {
    await invokeDirectHandler("cmdLs", ["--json", "-r", "5", "--active", "45m", "-v"]);
    expect(tmuxLsCalls).toEqual([{
      all: true,
      compact: false,
      verbose: true,
      roster: false,
      json: true,
      recent: true,
      recentLimit: 5,
      active: true,
      activeThresholdSec: 2700,
    }]);
    expect(lsFederatedCalls).toEqual([]);
  });

  test("cmdLs uses federation only when --federation is explicit", async () => {
    await invokeDirectHandler("cmdLs", ["--federation", "--json", "--active", "45m", "--node", "white"]);
    expect(lsFederatedCalls).toEqual([{
      json: true,
      node: "white",
      active: true,
      activeThresholdSec: 2700,
    }]);
    expect(tmuxLsCalls).toEqual([]);
    expect(logs).toEqual(["federated output"]);
  });



  test("cmdLayout prints layout help and applies presets to the current window", async () => {
    await invokeDirectHandler("cmdLayout", ["--help"]);
    expect(logs.join("\n")).toContain("usage: maw layout <preset>");
    expect(logs.join("\n")).toContain("maw tmux layout <target> <preset>");
    expect(tmuxLayoutCalls).toEqual([]);

    logs = [];
    await invokeDirectHandler("cmdLayout", ["main-vertical"]);
    expect(tmuxLayoutCalls).toEqual([[".", "main-vertical"]]);

    await expect(invokeDirectHandler("cmdLayout", [])).rejects.toThrow("layout: missing preset");
    expect(errors.join("\n")).toContain("usage: maw layout <preset>");
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
      "--layout", "legacy",
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
      layout: "legacy",
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
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdBring", ["neo", "--dry-run", "--main", "--task", "fix", "-e", "codex"]);
    expect(wakeCalls).toEqual([["neo", { task: "fix", dryRun: true, noRehydrate: true, split: true, bringAlias: true, engine: "codex" }]]);

    wakeCalls = [];
    await invokeDirectHandler("../commands/shared/wake-cmd:cmdBring", ["neo", "--to", "50-mawjs:maw-js-1816"]);
    expect(wakeCalls).toEqual([["neo", {
      session: "50-mawjs",
      splitTarget: "50-mawjs:maw-js-1816",
      split: true,
      bringAlias: true,
    }]]);
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
