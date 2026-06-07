/** Targeted isolated coverage for demo/project plugin index dispatchers. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

let demoCalls: Array<{ fast: boolean; hasSleep: boolean }> = [];
let demoError: Error | null = null;
let demoEmitConsole = false;

mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/demo/impl"), () => ({
  cmdDemo: async (opts: { fast?: boolean; sleep?: unknown }) => {
    demoCalls.push({ fast: !!opts.fast, hasSleep: typeof opts.sleep === "function" });
    if (demoEmitConsole) {
      console.log("demo log");
      console.error("demo err");
    }
    if (demoError) throw demoError;
  },
}));

const demoPlugin = await import("../../src/vendor/mpr-plugins/demo/index.ts?demo-project-index-coverage");
const projectPlugin = await import("../../src/vendor/mpr-plugins/project/index.ts?demo-project-index-coverage");
const projectImpl = await import("../../src/vendor/mpr-plugins/project/impl.ts?demo-project-index-coverage");

beforeEach(() => {
  demoCalls = [];
  demoError = null;
  demoEmitConsole = false;
});

function writerSink() {
  const writes: string[] = [];
  return { writes, writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")) };
}

describe("demo plugin index coverage", () => {
  test("exports command metadata and renders help without invoking demo", async () => {
    expect(demoPlugin.command).toMatchObject({ name: "demo" });

    const result = await demoPlugin.default({ source: "cli", args: ["--help"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw demo");
    expect(result.output).toContain("--fast");
    expect(demoCalls).toEqual([]);
  });

  test("dispatches cli and api modes with normalized fast options", async () => {
    await expect(demoPlugin.default({ source: "cli", args: ["--fast"] } as any)).resolves.toMatchObject({ ok: true });
    await expect(demoPlugin.default({ source: "api", args: { fast: 1 } } as any)).resolves.toMatchObject({ ok: true });

    expect(demoCalls).toEqual([
      { fast: true, hasSleep: false },
      { fast: true, hasSleep: true },
    ]);
  });

  test("captures demo errors and writer output", async () => {
    demoError = new Error("demo exploded");
    const { writes, writer } = writerSink();

    const result = await demoPlugin.default({ source: "cli", args: [], writer } as any);

    expect(result).toMatchObject({ ok: false, error: "demo exploded" });
    expect(writes).toEqual([]);
  });

  test("forwards demo console output to ctx.writer and restores console methods", async () => {
    demoEmitConsole = true;
    const origLog = console.log;
    const origError = console.error;
    const { writes, writer } = writerSink();

    const result = await demoPlugin.default({ source: "cli", args: [], writer } as any);

    expect(result).toMatchObject({ ok: true });
    expect(result.output).toBeUndefined();
    expect(writes).toEqual(["demo log", "demo err"]);
    expect(console.log).toBe(origLog);
    expect(console.error).toBe(origError);
  });
});

describe("project plugin index and stubs coverage", () => {
  test("exports command metadata and help text", async () => {
    expect(projectPlugin.command).toMatchObject({ name: "project" });
    expect(projectImpl.helpText()).toContain("usage: maw project");

    const result = await projectPlugin.default({ source: "cli", args: [] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("learn");
  });

  test("dispatches learn/incubate/find/search/list stubs", async () => {
    const cases = [
      ["learn", "https://github.com/a/b", "would clone"],
      ["incubate", "https://github.com/a/b", "ψ/incubate"],
      ["find", "maw", "would search"],
      ["search", "maw", "would search"],
    ];

    for (const [sub, arg, expected] of cases) {
      const result = await projectPlugin.default({ source: "cli", args: [sub, arg] } as any);
      expect(result.ok).toBe(true);
      expect(result.output).toContain(expected);
    }

    const list = await projectPlugin.default({ source: "cli", args: ["list"] } as any);
    expect(list.ok).toBe(true);
    expect(list.output).toContain("would list");
  });

  test("reports usage for missing args and unknown subcommands", async () => {
    await expect(projectPlugin.default({ source: "cli", args: ["learn"] } as any)).resolves.toMatchObject({ ok: false, error: "usage: maw project learn <url>" });
    await expect(projectPlugin.default({ source: "cli", args: ["incubate"] } as any)).resolves.toMatchObject({ ok: false, error: "usage: maw project incubate <url>" });
    await expect(projectPlugin.default({ source: "cli", args: ["find"] } as any)).resolves.toMatchObject({ ok: false, error: "usage: maw project find <query>" });

    const unknown = await projectPlugin.default({ source: "cli", args: ["wat"] } as any);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown subcommand");
    expect(unknown.output).toContain("usage: maw project");
  });

  test("api/peer source defaults to help and catch path maps thrown messages", async () => {
    const api = await projectPlugin.default({ source: "api", args: ["list"] } as any);
    expect(api.ok).toBe(true);
    expect(api.output).toContain("usage: maw project");
  });
});
