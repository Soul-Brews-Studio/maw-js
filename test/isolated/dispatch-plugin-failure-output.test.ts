import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

const plugin = {
  kind: "ts",
  disabled: false,
  dir: "/tmp/check-plugin",
  entryPath: "/tmp/check-plugin/index.ts",
  manifest: {
    name: "check-plugin",
    version: "1.0.0",
    sdk: "*",
    cli: { command: "check", help: "maw check" },
  },
};

let invokeResult: any;
let logs: string[] = [];
let errs: string[] = [];
let exitCode: number | undefined;

const original = {
  log: console.log,
  error: console.error,
  exit: process.exit,
};

mock.module(at("../../src/cli/route-comm"), () => ({
  routeComm: async () => false,
}));

mock.module(at("../../src/cli/route-tools"), () => ({
  routeTools: async () => false,
}));

mock.module(at("../../src/cli/top-aliases"), () => ({
  resolveTopAlias: () => null,
  invokeDirectHandler: async () => {},
}));

mock.module(at("../../src/cli/command-registry"), () => ({
  registerCommand: () => {},
  scanCommands: () => {},
  matchCommand: () => null,
  executeCommand: async () => {},
  listCommands: () => [],
}));

mock.module(at("../../src/plugin/registry"), () => ({
  discoverPackages: () => [plugin],
  importPluginSymbol: async () => undefined,
  invokePlugin: async () => invokeResult,
  resetDiscoverCache: () => {},
}));

mock.module(at("../../src/cli/dispatch-match"), () => ({
  resolvePluginMatch: () => ({ kind: "match", plugin, matchedName: "check" }),
  pluginCliNames: () => ({ command: "check", aliases: [] }),
  pluginNonCliSurfaces: () => [],
  validatePluginCliFlags: () => ({ ok: true }),
}));

mock.module(at("../../src/plugin/dependencies"), () => ({
  dependencyStatus: () => ({ missing: [], disabled: [] }),
  enablePlanFor: () => [],
}));

const { dispatchCommand } = await import("../../src/cli/dispatch.ts?plugin-failure-output");

async function capture(fn: () => Promise<void>) {
  logs = [];
  errs = [];
  exitCode = undefined;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  (process as any).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await fn();
  } catch (error) {
    return error;
  } finally {
    console.log = original.log;
    console.error = original.error;
    (process as any).exit = original.exit;
  }
}

beforeEach(() => {
  invokeResult = { ok: false, output: "drift found", exitCode: 3 };
});

afterAll(() => {
  console.log = original.log;
  console.error = original.error;
  (process as any).exit = original.exit;
});

describe("plugin CLI failure output", () => {
  test("prints failed InvokeResult output without an undefined error line", async () => {
    const error = await capture(() => dispatchCommand("check", ["check"]));

    expect(error).toBeInstanceOf(Error);
    expect(exitCode).toBe(3);
    expect(logs).toEqual(["drift found"]);
    expect(errs).toEqual([]);
    expect([...logs, ...errs].join("\n")).not.toContain("undefined");
  });
});
