import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const routeCommCalls: unknown[] = [];
const routeToolsCalls: unknown[] = [];
const invokeCalls: unknown[] = [];
const peekCalls: string[] = [];
let routeCommReturn = false;
let routeToolsReturn = false;
let plugins: any[] = [];
let resolveQueue: any[] = [];
let invokeResult: any = { ok: true };
let exitCode: number | undefined;
let errors: string[] = [];

mock.module(import.meta.resolve("../../src/cli/route-comm"), () => ({
  routeComm: async (cmd: string, args: string[]) => {
    routeCommCalls.push({ cmd, args: [...args] });
    return routeCommReturn;
  },
}));

mock.module(import.meta.resolve("../../src/cli/route-tools"), () => ({
  routeTools: async (cmd: string, args: string[]) => {
    routeToolsCalls.push({ cmd, args: [...args] });
    return routeToolsReturn;
  },
}));

mock.module(import.meta.resolve("../../src/cli/top-aliases"), () => ({
  resolveTopAlias: () => null,
  invokeDirectHandler: async () => {},
}));

mock.module(import.meta.resolve("../../src/cli/command-registry"), () => ({
  matchCommand: () => null,
  executeCommand: async () => {},
  listCommands: () => [],
}));

mock.module(import.meta.resolve("../../src/cli/cmd-version"), () => ({ getVersionString: () => "maw test" }));
mock.module(import.meta.resolve("../../src/cli/cmd-update"), () => ({ runUpdate: async () => {} }));

mock.module(import.meta.resolve("../../src/commands/shared/comm"), () => ({
  cmdSend: async () => {},
  cmdPeek: async (target: string) => { peekCalls.push(target); },
}));

mock.module(import.meta.resolve("../../src/plugin/registry"), () => ({
  discoverPackages: () => plugins,
  invokePlugin: async (plugin: any, ctx: any) => {
    invokeCalls.push({ plugin, ctx });
    return invokeResult;
  },
}));

mock.module(import.meta.resolve("../../src/cli/dispatch-match"), () => ({
  resolvePluginMatch: () => resolveQueue.shift() ?? { kind: "none" },
  pluginCliNames: (plugin: any) => plugin.cliNames ?? (plugin.manifest?.cli ? { command: plugin.manifest.cli.command, aliases: plugin.manifest.cli.aliases ?? [] } : null),
  pluginNonCliSurfaces: () => [],
  validatePluginCliFlags: () => ({ ok: true }),
}));

mock.module(import.meta.resolve("../../src/plugin/dependencies"), () => ({
  dependencyStatus: () => ({ missing: [], disabled: [] }),
  enablePlanFor: (plugin: any) => [plugin.manifest.name],
}));

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  FLEET_DIR: "/tmp/nonexistent-fleet-next-core",
  listSessions: async () => [],
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "claude",
  isAgentCommand: (cmd: string) => ["claude", "codex", "node"].includes(cmd),
  findPeerForTarget: async () => null,
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false }),
  runHook: async () => {},
  hostExec: async () => "",
  tmux: {
    listSessions: async () => [],
    setEnvironment: async () => {},
    hasSession: async () => true,
    run: async () => "",
  },
  restoreTabOrder: async () => 0,
  takeSnapshot: async () => {},
  getPaneInfos: async () => ({}),
}));

const { dispatchCommand } = await import("../../src/cli/dispatch.ts?coverage-next-core-dispatch");
const { UserError } = await import("../../src/core/util/user-error");

const originalExit = process.exit;
const originalError = console.error;

function plugin(name: string, extra: any = {}) {
  return {
    kind: "ts",
    dir: `/tmp/${name}`,
    entryPath: `/tmp/${name}/index.ts`,
    wasmPath: "",
    manifest: { name, version: "1.0.0", sdk: "*", cli: { command: name }, ...(extra.manifest ?? {}) },
    ...extra,
  };
}

async function capture(fn: () => Promise<void>) {
  exitCode = undefined;
  errors = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${exitCode}`); }) as never;
  try {
    await fn();
  } catch (error) {
    if (error instanceof UserError || (error instanceof Error && error.message.startsWith("exit:"))) return error;
    throw error;
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
}

beforeEach(() => {
  routeCommCalls.length = 0;
  routeToolsCalls.length = 0;
  invokeCalls.length = 0;
  peekCalls.length = 0;
  routeCommReturn = false;
  routeToolsReturn = false;
  plugins = [];
  resolveQueue = [];
  invokeResult = { ok: true };
  exitCode = undefined;
  errors = [];
});

afterAll(() => {
  console.error = originalError;
  process.exit = originalExit;
});

describe("coverage next dispatch", () => {
  test("short-circuits when comm or tools routes handle a command", async () => {
    routeCommReturn = true;
    await dispatchCommand("send", ["send", "opal"]);
    expect(routeCommCalls).toEqual([{ cmd: "send", args: ["send", "opal"] }]);
    expect(routeToolsCalls).toEqual([]);

    routeCommReturn = false;
    routeToolsReturn = true;
    await dispatchCommand("serve", ["serve", "status"]);
    expect(routeToolsCalls).toEqual([{ cmd: "serve", args: ["serve", "status"] }]);
  });

  test("plugin matches with no output still exit cleanly", async () => {
    const p = plugin("quiet");
    resolveQueue = [{ kind: "match", plugin: p, matchedName: "quiet" }];

    await capture(() => dispatchCommand("quiet", ["quiet", "--ok"]));

    expect(invokeCalls).toHaveLength(1);
    expect((invokeCalls[0] as any).ctx).toEqual({ source: "cli", args: ["--ok"], matchedName: "quiet" });
    expect(exitCode).toBe(0);
  });

  test("disabled plugin aliases name the provider in the error", async () => {
    const p = plugin("quiet", { disabled: true, cliNames: { command: "quiet", aliases: ["q"] } });
    plugins = [p];
    resolveQueue = [{ kind: "none" }, { kind: "match", plugin: p, matchedName: "q" }];

    const error = await capture(() => dispatchCommand("q", ["q"]));

    expect(error).toBeInstanceOf(UserError);
    expect(errors.join("\n")).toContain("provided by disabled plugin 'quiet'");
  });

  test("known command names skip typo handling and fall through to shorthand peek", async () => {
    resolveQueue = [{ kind: "none" }, { kind: "none" }];

    await dispatchCommand("serve", ["serve"]);

    expect(peekCalls).toEqual(["serve"]);
  });
});
