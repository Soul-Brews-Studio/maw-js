/**
 * Isolated coverage for src/vendor/mpr-plugins/bg/src/index.ts.
 *
 * The plugin index is a dispatcher; mock the tmux-backed implementation so
 * tests can exercise argument normalization, formatting, and error handling
 * without spawning or attaching real tmux sessions.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

type BgSession = {
  slug: string;
  session: string;
  ageSeconds: number;
  status: "running" | "done";
  lastLine: string;
};

type GcReport = {
  dryRun: boolean;
  reaped: string[];
  kept: string[];
  thresholdSeconds: number;
};

const calls: Record<string, unknown[]> = {
  bgSpawn: [],
  bgList: [],
  bgTail: [],
  bgTailFollow: [],
  bgAttach: [],
  bgKill: [],
  bgGc: [],
};

let sessions: BgSession[] = [];
let spawnResult = { slug: "spawned", session: "maw-bg-spawned", cmd: "echo hi" };
let tailOutput = "tail output";
let attachCode = 0;
let killResult: string[] = [];
let gcResult: GcReport = {
  dryRun: false,
  reaped: [],
  kept: [],
  thresholdSeconds: 24 * 60 * 60,
};
let throwFrom: keyof typeof calls | null = null;
let thrownValue: unknown = null;

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
}

function maybeThrow(name: keyof typeof calls) {
  if (throwFrom === name) throw thrownValue;
}

mock.module(join(root, "src/vendor/mpr-plugins/bg/src/impl"), () => ({
  bgSpawn: (cmd: string, opts: Record<string, unknown>) => {
    calls.bgSpawn.push([cmd, opts]);
    maybeThrow("bgSpawn");
    return spawnResult;
  },
  bgList: () => {
    calls.bgList.push([]);
    maybeThrow("bgList");
    return sessions;
  },
  bgTail: (slug: string, opts: Record<string, unknown>) => {
    calls.bgTail.push([slug, opts]);
    maybeThrow("bgTail");
    return tailOutput;
  },
  bgTailFollow: async (slug: string, opts: Record<string, unknown>) => {
    calls.bgTailFollow.push([slug, opts]);
    maybeThrow("bgTailFollow");
  },
  bgAttach: async (slug: string) => {
    calls.bgAttach.push([slug]);
    maybeThrow("bgAttach");
    return attachCode;
  },
  bgKill: (slug: string | undefined, opts: Record<string, unknown>) => {
    calls.bgKill.push([slug, opts]);
    maybeThrow("bgKill");
    return killResult;
  },
  bgGc: (opts: Record<string, unknown>) => {
    calls.bgGc.push([opts]);
    maybeThrow("bgGc");
    return gcResult;
  },
}));

const {
  default: handler,
  manifest,
  bgSpawn,
  parseFlags,
  UserError,
} = await import("../../src/vendor/mpr-plugins/bg/src/index.ts?vendor-bg-plugin-coverage");

beforeEach(() => {
  resetCalls();
  sessions = [];
  spawnResult = { slug: "spawned", session: "maw-bg-spawned", cmd: "echo hi" };
  tailOutput = "tail output";
  attachCode = 0;
  killResult = [];
  gcResult = {
    dryRun: false,
    reaped: [],
    kept: [],
    thresholdSeconds: 24 * 60 * 60,
  };
  throwFrom = null;
  thrownValue = null;
});

describe("vendored bg plugin dispatcher coverage", () => {
  test("exports metadata, implementation helpers, and flag/error utilities", () => {
    expect(manifest).toEqual({
      name: "bg",
      version: "0.1.0",
      description: "Run long commands in detached tmux and sample output without blocking the current pane.",
    });
    expect(typeof bgSpawn).toBe("function");
    expect(parseFlags(["--json", "ls"])).toEqual({ json: true, _: ["ls"] });
    expect(new UserError("nope", 7).exitCode).toBe(7);
  });

  test("normalizes raw argv, cli contexts, and non-cli contexts into help output", async () => {
    for (const ctx of [
      [] as string[],
      ["--help"],
      ["-h"],
      undefined as unknown as string[],
      { source: "api", args: ["ls"] },
      { source: "peer", args: ["tail", "build"] },
    ]) {
      const result = await handler(ctx as never);
      expect(result).toEqual({
        ok: true,
        output: expect.stringContaining("maw bg"),
      });
    }
    expect(calls.bgList).toHaveLength(0);
    expect(calls.bgTail).toHaveLength(0);
  });

  test("spawns commands from positional args and reports missing command as a UserError", async () => {
    let result = await handler({ source: "cli", args: ["npm", "test", "--name=unit-run"] });
    expect(result).toEqual({ ok: true, output: "spawned\tmaw-bg-spawned" });
    expect(calls.bgSpawn).toEqual([["npm test", { name: "unit-run" }]]);

    resetCalls();
    spawnResult = { slug: "derived", session: "maw-bg-derived", cmd: "echo hi" };
    result = await handler(["echo", "hi"]);
    expect(result).toEqual({ ok: true, output: "derived\tmaw-bg-derived" });
    expect(calls.bgSpawn).toEqual([["echo hi", {}]]);

    result = await handler(["--name", "lonely"]);
    expect(result).toEqual({
      ok: false,
      error: "Error: bg: missing command (usage: maw bg \"<cmd>\")",
      exitCode: 1,
    });
  });

  test("formats empty and populated session lists, including json output", async () => {
    let result = await handler(["ls"]);
    expect(result).toEqual({ ok: true, output: "(no maw-bg sessions)" });

    sessions = [
      { slug: "short", session: "maw-bg-short", ageSeconds: 5, status: "running", lastLine: "warm" },
      { slug: "minute", session: "maw-bg-minute", ageSeconds: 120, status: "running", lastLine: "building" },
      { slug: "hour", session: "maw-bg-hour", ageSeconds: 7200, status: "done", lastLine: "complete" },
      {
        slug: "day",
        session: "maw-bg-day",
        ageSeconds: 172800,
        status: "done",
        lastLine: "x".repeat(70),
      },
    ];

    result = await handler(["list"]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("short   running  5s");
    expect(result.output).toContain("minute  running  2m");
    expect(result.output).toContain("hour    done     2h");
    expect(result.output).toContain("day     done     2d");
    expect(result.output).toContain(`${"x".repeat(57)}...`);
    expect(result.output).not.toContain("x".repeat(70));

    result = await handler(["ls", "--json"]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output ?? "")).toEqual(sessions);
    expect(calls.bgList).toHaveLength(3);
  });

  test("tails once, follows, and maps parse and missing-slug failures", async () => {
    let result = await handler(["tail"]);
    expect(result).toEqual({
      ok: false,
      error: "Error: bg tail: missing <slug>",
      exitCode: 1,
    });

    result = await handler(["tail", "build", "--lines=10"]);
    expect(result).toEqual({ ok: true, output: "tail output" });
    expect(calls.bgTail).toEqual([["build", { lines: 10 }]]);

    result = await handler(["tail", "build", "--follow", "--lines", "3"]);
    expect(result).toEqual({ ok: true });
    expect(calls.bgTailFollow).toEqual([["build", { lines: 3 }]]);

    result = await handler(["tail", "build", "--lines", "nope"]);
    expect(result).toEqual({
      ok: false,
      error: "Error: --lines must be a positive number, got nope",
    });
  });

  test("attaches by slug and preserves implementation exit codes", async () => {
    let result = await handler(["attach"]);
    expect(result).toEqual({
      ok: false,
      error: "Error: bg attach: missing <slug>",
      exitCode: 1,
    });

    result = await handler(["attach", "build"]);
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(calls.bgAttach).toEqual([["build"]]);

    attachCode = 13;
    result = await handler(["attach", "failed"]);
    expect(result).toEqual({ ok: false, exitCode: 13 });
    expect(calls.bgAttach).toEqual([["build"], ["failed"]]);
  });

  test("kills single, all, or missing-target sessions and reports no-op kills", async () => {
    let result = await handler(["kill"]);
    expect(result).toEqual({ ok: true, output: "(no sessions to kill)" });
    expect(calls.bgKill).toEqual([[undefined, { all: undefined }]]);

    result = await handler(["kill", "--all"]);
    expect(result).toEqual({ ok: true, output: "(no sessions to kill)" });
    expect(calls.bgKill).toEqual([[undefined, { all: undefined }], [undefined, { all: true }]]);

    killResult = ["one-a111", "two-b222"];
    result = await handler(["kill", "one"]);
    expect(result).toEqual({ ok: true, output: "killed: one-a111, two-b222" });
    expect(calls.bgKill).toEqual([
      [undefined, { all: undefined }],
      [undefined, { all: true }],
      ["one", { all: undefined }],
    ]);
  });

  test("formats gc reports for dry-run, live, empty, and threshold options", async () => {
    gcResult = {
      dryRun: true,
      reaped: ["old-done"],
      kept: ["young-done", "running"],
      thresholdSeconds: 7200,
    };
    let result = await handler(["gc", "--dry-run", "--older-than", "2h"]);
    expect(result).toEqual({
      ok: true,
      output: "would reap: old-done\nkept:    young-done, running\nthreshold: 7200s",
    });
    expect(calls.bgGc).toEqual([[{ dryRun: true, olderThan: "2h" }]]);

    gcResult = {
      dryRun: false,
      reaped: [],
      kept: [],
      thresholdSeconds: 24 * 60 * 60,
    };
    result = await handler(["gc"]);
    expect(result).toEqual({
      ok: true,
      output: "reaped: (none)\nkept:    (none)\nthreshold: 86400s",
    });
    expect(calls.bgGc).toEqual([[{ dryRun: true, olderThan: "2h" }], [{}]]);
  });

  test("maps regular Error objects and non-Error throws into handler errors", async () => {
    throwFrom = "bgList";
    thrownValue = new Error("list exploded");
    let result = await handler(["ls"]);
    expect(result).toEqual({ ok: false, error: "Error: list exploded" });

    throwFrom = "bgGc";
    thrownValue = "string exploded";
    result = await handler(["gc"]);
    expect(result).toEqual({ ok: false, error: "Error: string exploded" });
  });
});
