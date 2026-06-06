/** Focused isolated coverage for the thin done plugin index wrapper. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type InvokeCtx = { source: "cli" | "api"; args: unknown; writer?: (...args: unknown[]) => void };
type DoneOpts = { force?: boolean; dryRun?: boolean; cleanBranch?: boolean; oracle?: string };

let doneCalls: Array<{ name: string; opts: DoneOpts }> = [];
let doneAllCalls: DoneOpts[] = [];
let mode: "ok" | "throw-with-log" | "throw-plain" = "ok";

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/impl.ts"), () => ({
  cmdDone: async (name: string, opts: DoneOpts) => {
    doneCalls.push({ name, opts });
    if (mode === "throw-with-log") {
      console.error("logged failure");
      throw new Error("plain failure");
    }
    if (mode === "throw-plain") throw new Error("plain failure");
    console.log(`done:${name}:${Boolean(opts.force)}:${Boolean(opts.dryRun)}`);
  },
  cmdDoneAll: async (opts: DoneOpts) => {
    doneAllCalls.push(opts);
    if (mode === "throw-with-log") {
      console.error("all logged failure");
      throw new Error("all plain failure");
    }
    console.error(`all:${Boolean(opts.force)}:${Boolean(opts.dryRun)}`);
  },
}));

const donePlugin = await import("../../src/vendor/mpr-plugins/done/index.ts?done-index-coverage");

beforeEach(() => {
  doneCalls = [];
  doneAllCalls = [];
  mode = "ok";
});

describe("done plugin index wrapper", () => {
  test("exports metadata and maps API args to cmdDone while capturing console output", async () => {
    expect(donePlugin.command).toMatchObject({ name: ["done", "finish"] });

    const result = await donePlugin.default({
      source: "api",
      args: { name: "tile-1", force: true, dryRun: true, cleanBranch: true },
    } as InvokeCtx);

    expect(result).toEqual({ ok: true, output: "done:tile-1:true:true" });
    expect(doneCalls).toEqual([{ name: "tile-1", opts: { force: true, dryRun: true, cleanBranch: true, cwd: process.cwd() } }]);
    expect(doneAllCalls).toEqual([]);
  });

  test("routes API --all options to cmdDoneAll and preserves writer output", async () => {
    const lines: string[] = [];

    const result = await donePlugin.default({
      source: "api",
      args: { all: true, force: true, dryRun: false, clean_branch: true },
      writer: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    } as InvokeCtx);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(doneAllCalls).toEqual([{ force: true, dryRun: false, cleanBranch: true, cwd: process.cwd() }]);
    expect(lines).toEqual(["all:true:false"]);
  });

  test("accepts --all with a positional oracle and forwards it to cmdDoneAll", async () => {
    const result = await donePlugin.default({
      source: "cli",
      args: ["arra-oracle-v3", "--all", "--dry-run"],
    } as InvokeCtx);

    expect(result.ok).toBe(true);
    expect(doneAllCalls).toEqual([{ force: false, dryRun: true, cleanBranch: false, oracle: "arra-oracle-v3", cwd: process.cwd() }]);
    expect(doneCalls).toEqual([]);
  });

  test("maps API --all with oracle argument to cmdDoneAll", async () => {
    const result = await donePlugin.default({
      source: "api",
      args: { all: true, oracle: "mawjs", force: true },
    } as InvokeCtx);

    expect(result.ok).toBe(true);
    expect(doneAllCalls).toEqual([{ force: true, dryRun: false, cleanBranch: false, oracle: "mawjs", cwd: process.cwd() }]);
  });

  test("maps CLI --clean-branch to cmdDone", async () => {
    const result = await donePlugin.default({
      source: "cli",
      args: ["tile-2", "--force", "--clean-branch"],
    } as InvokeCtx);

    expect(result.ok).toBe(true);
    expect(doneCalls).toEqual([{ name: "tile-2", opts: { force: true, dryRun: false, cleanBranch: true, cwd: process.cwd() } }]);
  });


  test("rejects ambiguous CLI positional args before invoking teardown", async () => {
    const typo = await donePlugin.default({
      source: "cli",
      args: ["all", "33-arraoraclev3", "--dry-run"],
    } as InvokeCtx);

    expect(typo.ok).toBe(false);
    expect(typo.error).toContain("unexpected extra positional");
    expect(typo.error).toContain("33-arraoraclev3");
    expect(typo.error).toContain("did you mean `maw done --all`");

    const allWithTooManyTargets = await donePlugin.default({ source: "cli", args: ["--all", "33-arraoraclev3", "extra"] } as InvokeCtx);
    expect(allWithTooManyTargets.ok).toBe(false);
    expect(allWithTooManyTargets.error).toContain("unexpected extra positional arg(s) for maw done --all");
    expect(allWithTooManyTargets.error).toContain("extra");
    expect(doneCalls).toEqual([]);
    expect(doneAllCalls).toEqual([]);
  });

  test("returns usage for missing API name without calling implementation", async () => {
    const result = await donePlugin.default({ source: "api", args: {} } as InvokeCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw done <window-name>");
    expect(doneCalls).toEqual([]);
    expect(doneAllCalls).toEqual([]);
  });

  test("catch path prefers captured logs, then falls back to thrown error message", async () => {
    mode = "throw-with-log";
    await expect(donePlugin.default({ source: "cli", args: ["tile-1"] } as InvokeCtx)).resolves.toEqual({
      ok: false,
      error: "logged failure",
      output: "logged failure",
    });

    mode = "throw-plain";
    await expect(donePlugin.default({ source: "cli", args: ["tile-2"] } as InvokeCtx)).resolves.toEqual({
      ok: false,
      error: "plain failure",
      output: undefined,
    });
  });
});
