/** Focused isolated coverage for the thin done plugin index wrapper. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type InvokeCtx = { source: "cli" | "api"; args: unknown; writer?: (...args: unknown[]) => void };

let doneCalls: Array<{ name: string; opts: { force?: boolean; dryRun?: boolean } }> = [];
let doneAllCalls: Array<{ force?: boolean; dryRun?: boolean }> = [];
let mode: "ok" | "throw-with-log" | "throw-plain" = "ok";

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/impl.ts"), () => ({
  cmdDone: async (name: string, opts: { force?: boolean; dryRun?: boolean }) => {
    doneCalls.push({ name, opts });
    if (mode === "throw-with-log") {
      console.error("logged failure");
      throw new Error("plain failure");
    }
    if (mode === "throw-plain") throw new Error("plain failure");
    console.log(`done:${name}:${Boolean(opts.force)}:${Boolean(opts.dryRun)}`);
  },
  cmdDoneAll: async (opts: { force?: boolean; dryRun?: boolean }) => {
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
      args: { name: "tile-1", force: true, dryRun: true },
    } as InvokeCtx);

    expect(result).toEqual({ ok: true, output: "done:tile-1:true:true" });
    expect(doneCalls).toEqual([{ name: "tile-1", opts: { force: true, dryRun: true } }]);
    expect(doneAllCalls).toEqual([]);
  });

  test("routes API --all options to cmdDoneAll and preserves writer output", async () => {
    const lines: string[] = [];

    const result = await donePlugin.default({
      source: "api",
      args: { all: true, force: true, dryRun: false },
      writer: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    } as InvokeCtx);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(doneAllCalls).toEqual([{ force: true, dryRun: false }]);
    expect(lines).toEqual(["all:true:false"]);
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
