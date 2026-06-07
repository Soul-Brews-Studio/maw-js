import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const originalArgv = process.argv;

let auditCalls: Array<{ cmd: string; args: string[] }> = [];
let verbosityCalls: unknown[] = [];
let versionCalls = 0;
let updateCalls: string[][] = [];
let bootstrapCalls: Array<{ pluginDir: string; sourceDir: string }> = [];
let scanCalls: Array<{ pluginDir: string; scope: string }> = [];
let restoreCalls: Array<string | undefined> = [];
let usageCalls = 0;
let dispatchCalls: Array<{ cmd: string; args: string[] }> = [];
let handledErrors: Array<{ error: unknown; args: string[] }> = [];

mock.module(import.meta.resolve("../../src/cli/instance-preset"), () => ({
  applyInstancePreset: () => {},
}));
mock.module(import.meta.resolve("../../src/core/fleet/audit"), () => ({
  logAudit: (cmd: string, args: string[]) => auditCalls.push({ cmd, args }),
}));
mock.module(import.meta.resolve("../../src/cli/usage"), () => ({
  usage: () => { usageCalls += 1; },
}));
mock.module(import.meta.resolve("../../src/cli/command-registry"), () => ({
  scanCommands: async (pluginDir: string, scope: string) => { scanCalls.push({ pluginDir, scope }); },
}));
mock.module(import.meta.resolve("../../src/cli/verbosity"), () => ({
  setVerbosityFlags: (flags: unknown) => verbosityCalls.push(flags),
}));
mock.module(import.meta.resolve("../../src/cli/cmd-version"), () => ({
  getVersionString: () => { versionCalls += 1; return "maw test-version"; },
}));
mock.module(import.meta.resolve("../../src/cli/cmd-update"), () => ({
  runUpdate: async (args: string[]) => { updateCalls.push(args); },
}));
mock.module(import.meta.resolve("../../src/cli/plugin-bootstrap"), () => ({
  runBootstrap: async (pluginDir: string, sourceDir: string) => { bootstrapCalls.push({ pluginDir, sourceDir }); },
}));
mock.module(import.meta.resolve("../../src/cli/auto-restore"), () => ({
  maybeAutoRestore: async (cmd?: string) => { restoreCalls.push(cmd); },
}));
mock.module(import.meta.resolve("../../src/cli/dispatch"), () => ({
  dispatchCommand: async (cmd: string, args: string[]) => { dispatchCalls.push({ cmd, args }); },
}));
mock.module(import.meta.resolve("../../src/cli/error-handler"), () => ({
  handleTopLevelError: (error: unknown, args: string[]) => { handledErrors.push({ error, args }); },
}));

async function importCliWith(args: string[], tag: string): Promise<void> {
  process.argv = ["bun", "maw", ...args];
  await import(`../../src/cli.ts?coverage-100b-shared-cli-${tag}`);
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  auditCalls = [];
  verbosityCalls = [];
  versionCalls = 0;
  updateCalls = [];
  bootstrapCalls = [];
  scanCalls = [];
  restoreCalls = [];
  usageCalls = 0;
  dispatchCalls = [];
  handledErrors = [];
});

afterEach(() => {
  process.argv = originalArgv;
});

describe("src/cli top-level early branches", () => {
  test("prints version and returns before plugin bootstrap", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      await importCliWith(["--quiet", "version"], "version");
    } finally {
      console.log = originalLog;
    }

    expect(logs).toEqual(["maw test-version"]);
    expect(versionCalls).toBe(1);
    expect(verbosityCalls).toEqual([{ quiet: true }]);
    expect(auditCalls).toEqual([{ cmd: "version", args: ["version"] }]);
    expect(bootstrapCalls).toEqual([]);
    expect(dispatchCalls).toEqual([]);
    expect(handledErrors).toEqual([]);
  });

  test("runs update aliases and returns before plugin bootstrap", async () => {
    await importCliWith(["--silent", "upgrade", "--check"], "upgrade");

    expect(updateCalls).toEqual([["upgrade", "--check"]]);
    expect(verbosityCalls).toEqual([{ silent: true }]);
    expect(auditCalls).toEqual([{ cmd: "upgrade", args: ["upgrade", "--check"] }]);
    expect(bootstrapCalls).toEqual([]);
    expect(dispatchCalls).toEqual([]);
  });

  test("prints usage for empty/help command after bootstrap and restore", async () => {
    await importCliWith(["--help"], "help");

    expect(bootstrapCalls).toHaveLength(1);
    expect(scanCalls).toEqual([{ pluginDir: bootstrapCalls[0]!.pluginDir, scope: "user" }]);
    expect(restoreCalls).toEqual(["--help"]);
    expect(usageCalls).toBe(1);
    expect(dispatchCalls).toEqual([]);
  });
});
