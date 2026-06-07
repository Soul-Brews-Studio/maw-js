import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "../..");

let cmdDemoCalls: any[] = [];
let cmdDemoThrow: Error | null = null;
let cmdDemoConsoleOutput = false;

mock.module(join(srcRoot, "src/vendor/mpr-plugins/demo/impl"), () => ({
  cmdDemo: async (opts: any) => {
    cmdDemoCalls.push(opts);
    if (opts.sleep) await opts.sleep(1);
    if (cmdDemoConsoleOutput) {
      console.log("demo console log");
      console.error("demo console error");
    }
    if (cmdDemoThrow) throw cmdDemoThrow;
  },
}));

const { default: demoHandler } = await import("../../src/vendor/mpr-plugins/demo/index.ts?demo-index-coverage");

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  cmdDemoCalls = [];
  cmdDemoThrow = null;
  cmdDemoConsoleOutput = false;
  console.log = originalLog;
  console.error = originalError;
});

describe("demo index coverage", () => {
  test("returns CLI help without invoking the demo runner", async () => {
    await expect(demoHandler({ source: "cli", args: ["--help"] } as any)).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("maw demo — simulated multi-agent session"),
    });
    await expect(demoHandler({ source: "cli", args: ["-h"] } as any)).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("Usage: maw demo [--fast]"),
    });
    expect(cmdDemoCalls).toEqual([]);
  });

  test("runs CLI fast mode and captures console output through writer", async () => {
    cmdDemoConsoleOutput = true;
    const written: string[] = [];

    const result = await demoHandler({
      source: "cli",
      args: ["--fast"],
      writer: (...parts: unknown[]) => written.push(parts.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(cmdDemoCalls).toHaveLength(1);
    expect(cmdDemoCalls[0]).toMatchObject({ fast: true });
    expect(written).toEqual(["demo console log", "demo console error"]);
  });

  test("runs API mode with non-interactive sleep override", async () => {
    const result = await demoHandler({ source: "api", args: { fast: true } } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(cmdDemoCalls).toHaveLength(1);
    expect(cmdDemoCalls[0].fast).toBe(true);
    expect(typeof cmdDemoCalls[0].sleep).toBe("function");
  });

  test("returns runner errors with captured output and restores console hooks", async () => {
    cmdDemoConsoleOutput = true;
    cmdDemoThrow = new Error("demo failed");

    const result = await demoHandler({ source: "api", args: { fast: false } } as any);

    expect(result).toEqual({
      ok: false,
      error: "demo failed",
      output: ["demo console log", "demo console error"].join("\n"),
    });
    expect(console.log).toBe(originalLog);
    expect(console.error).toBe(originalError);
  });
});
