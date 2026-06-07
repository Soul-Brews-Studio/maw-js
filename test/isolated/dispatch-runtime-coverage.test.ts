import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

const routeCommCalls: any[] = [];
const routeToolsCalls: any[] = [];
const executeCalls: any[] = [];
const invokeCalls: any[] = [];
const directCalls: any[] = [];
const sendCalls: any[] = [];
const peekCalls: any[] = [];
const updateCalls: any[] = [];
let routeCommReturn = false;
let routeToolsReturn = false;
let aliasResult: any = null;
let matchQueue: any[] = [];
let listCommandsReturn: any[] = [];
let plugins: any[] = [];
let resolveQueue: any[] = [];
let flagValidation: any = { ok: true };
let dependencyReturn: any = { missing: [], disabled: [] };
let enablePlanReturn: string[] = [];
let invokeResult: any = { ok: true, output: "plugin ok" };
let versionString = "maw 1.2.3-test";
let sessionsReturn: any[] = [];
let logs: string[] = [];
let errs: string[] = [];
let exitCode: number | undefined;

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;

mock.module(at("../../src/cli/route-comm"), () => ({
  routeComm: async (cmd: string, args: string[]) => {
    routeCommCalls.push({ cmd, args: [...args] });
    return routeCommReturn;
  },
}));

mock.module(at("../../src/cli/route-tools"), () => ({
  routeTools: async (cmd: string, args: string[]) => {
    routeToolsCalls.push({ cmd, args: [...args] });
    return routeToolsReturn;
  },
}));

mock.module(at("../../src/cli/top-aliases"), () => ({
  resolveTopAlias: (args: string[]) => aliasResult,
  invokeDirectHandler: async (handler: string, argv: string[]) => {
    directCalls.push({ handler, argv: [...argv] });
  },
}));

mock.module(at("../../src/cli/command-registry"), () => ({
  matchCommand: (args: string[]) => matchQueue.shift() ?? null,
  executeCommand: async (desc: any, remaining: string[]) => {
    executeCalls.push({ desc, remaining: [...remaining] });
  },
  listCommands: () => listCommandsReturn,
}));

mock.module(at("../../src/cli/cmd-version"), () => ({
  getVersionString: () => versionString,
}));

mock.module(at("../../src/cli/cmd-update"), () => ({
  runUpdate: async (args: string[]) => {
    updateCalls.push([...args]);
  },
}));

mock.module(at("../../src/commands/shared/comm"), () => ({
  cmdSend: async (target: string, message: string, force: boolean) => {
    sendCalls.push({ target, message, force });
  },
  cmdPeek: async (target: string) => {
    peekCalls.push(target);
  },
}));

mock.module(at("../../src/plugin/registry"), () => ({
  discoverPackages: () => plugins,
  invokePlugin: async (plugin: any, ctx: any) => {
    invokeCalls.push({ plugin, ctx });
    return invokeResult;
  },
}));

mock.module(at("../../src/cli/dispatch-match"), () => ({
  resolvePluginMatch: (inputPlugins: any[], cmdName: string, options?: any) => {
    return resolveQueue.shift() ?? { kind: "none" };
  },
  pluginCliNames: (plugin: any) => Object.prototype.hasOwnProperty.call(plugin, "cliNames") ? plugin.cliNames : (plugin.manifest?.cli ? { command: plugin.manifest.cli.command, aliases: plugin.manifest.cli.aliases ?? [] } : null),
  pluginNonCliSurfaces: (plugin: any) => plugin.surfaces ?? [],
  validatePluginCliFlags: () => flagValidation,
}));

mock.module(at("../../src/plugin/dependencies"), () => ({
  dependencyStatus: () => dependencyReturn,
  enablePlanFor: () => enablePlanReturn,
}));

mock.module(at("../../src/sdk"), () => ({
  listSessions: async () => sessionsReturn,
}));

const { dispatchCommand } = await import("../../src/cli/dispatch.ts?dispatch-runtime-coverage");
const { UserError } = await import("../../src/core/util/user-error");

function plugin(name: string, extra: any = {}) {
  return {
    kind: "ts",
    dir: `/tmp/${name}`,
    wasmPath: "",
    entryPath: `/tmp/${name}/index.ts`,
    manifest: { name, version: "1.0.0", sdk: "*", cli: { command: name, help: `maw ${name} [flags]` }, ...(extra.manifest ?? {}) },
    ...extra,
  };
}

async function capture(fn: () => Promise<void>) {
  exitCode = undefined;
  logs = [];
  errs = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  (process as any).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__") && !(error instanceof UserError)) throw error;
    return error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    (process as any).exit = originalExit;
  }
}

beforeEach(() => {
  routeCommCalls.length = 0;
  routeToolsCalls.length = 0;
  executeCalls.length = 0;
  invokeCalls.length = 0;
  directCalls.length = 0;
  sendCalls.length = 0;
  peekCalls.length = 0;
  updateCalls.length = 0;
  routeCommReturn = false;
  routeToolsReturn = false;
  aliasResult = null;
  matchQueue = [];
  listCommandsReturn = [];
  plugins = [];
  resolveQueue = [];
  flagValidation = { ok: true };
  dependencyReturn = { missing: [], disabled: [] };
  enablePlanReturn = [];
  invokeResult = { ok: true, output: "plugin ok" };
  versionString = "maw 1.2.3-test";
  sessionsReturn = [];
  logs = [];
  errs = [];
  exitCode = undefined;
});

afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
  (process as any).exit = originalExit;
});

describe("dispatchCommand runtime coverage", () => {
  test("top aliases dispatch direct handlers and rewrite argv before command-registry execution", async () => {
    aliasResult = { kind: "direct", handler: "cmdLs", argv: ["--json"] };
    await dispatchCommand("ls", ["ls"]);
    expect(directCalls).toEqual([{ handler: "cmdLs", argv: ["--json"] }]);

    aliasResult = { kind: "rewrite", argv: ["registered", "--fast"] };
    matchQueue = [{ desc: { name: "registered" }, remaining: ["--fast"] }];
    await dispatchCommand("r", ["r"]);
    expect(executeCalls.at(-1)).toEqual({ desc: { name: "registered" }, remaining: ["--fast"] });
  });

  test("plugin registry reports ambiguous matches and dependency gates", async () => {
    resolveQueue = [{ kind: "ambiguous", candidates: [{ plugin: "one", name: "run" }, { plugin: "two", name: "run" }] }];
    const ambiguous = await capture(() => dispatchCommand("run", ["run"]));
    expect(ambiguous).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("ambiguous command: run");
    expect(errs.join("\n")).toContain("one (run), two (run)");

    const p = plugin("needs");
    resolveQueue = [{ kind: "match", plugin: p, matchedName: "needs" }];
    dependencyReturn = { missing: ["base"], disabled: [] };
    const missing = await capture(() => dispatchCommand("needs", ["needs"]));
    expect(missing).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("needs missing plugins: base");

    resolveQueue = [{ kind: "match", plugin: p, matchedName: "needs" }];
    dependencyReturn = { missing: [], disabled: ["base"] };
    const disabled = await capture(() => dispatchCommand("needs", ["needs"]));
    expect(disabled).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("needs disabled plugins: base");
  });

  test("plugin registry validates flags, prints output, and exits with plugin failures", async () => {
    const p = plugin("tool");
    dependencyReturn = { missing: [], disabled: [] };
    flagValidation = { ok: false, flag: "--verbse", suggestion: "--verbose" };
    resolveQueue = [{ kind: "match", plugin: p, matchedName: "tool" }];
    const badFlag = await capture(() => dispatchCommand("tool", ["tool", "--verbse"]));
    expect(badFlag).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("unknown flag for tool: --verbse");
    expect(errs.join("\n")).toContain("did you mean: --verbose");
    expect(errs.join("\n")).toContain("usage: maw tool [flags]");

    flagValidation = { ok: true };
    invokeResult = { ok: true, output: "hello from plugin" };
    resolveQueue = [{ kind: "match", plugin: p, matchedName: "tool" }];
    await capture(() => dispatchCommand("tool", ["tool", "arg"]));
    expect(logs).toEqual(["hello from plugin"]);
    expect(exitCode).toBe(0);
    expect(invokeCalls.at(-1).ctx).toEqual({ source: "cli", args: ["arg"], matchedName: "tool" });

    invokeResult = { ok: false, error: "plugin exploded", exitCode: 7 };
    resolveQueue = [{ kind: "match", plugin: p, matchedName: "tool" }];
    await capture(() => dispatchCommand("tool", ["tool"]));
    expect(errs).toEqual(["plugin exploded"]);
    expect(exitCode).toBe(7);
  });

  test("disabled and headless plugins produce actionable errors", async () => {
    const disabledPlugin = plugin("sleepy");
    resolveQueue = [{ kind: "none" }, { kind: "match", plugin: disabledPlugin, matchedName: "sleepy" }];
    enablePlanReturn = ["dep", "sleepy"];
    const disabled = await capture(() => dispatchCommand("sleepy", ["sleepy"]));
    expect(disabled).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("'sleepy' is installed but disabled.");
    expect(errs.join("\n")).toContain("maw plugin enable dep sleepy");

    resolveQueue = [{ kind: "none" }, { kind: "ambiguous", candidates: [{ plugin: "a" }, { plugin: "b" }] }];
    const ambiguousDisabled = await capture(() => dispatchCommand("s", ["s"]));
    expect(ambiguousDisabled).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("matches disabled plugins");
    expect(errs.join("\n")).toContain("a, b");

    const apiOnly = plugin("api-only", { cliNames: null, surfaces: ["api:GET /x", "hooks:on"] });
    plugins = [apiOnly];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    const headless = await capture(() => dispatchCommand("api-only", ["api-only"]));
    expect(headless).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("has no CLI command");
    expect(errs.join("\n")).toContain("surfaces: api:GET /x, hooks:on");
  });

  test("unique prefix auto-resolves command registry, plugin, version, and update routes", async () => {
    listCommandsReturn = [{ name: "cleanup" }];
    matchQueue = [null, { desc: { name: "cleanup" }, remaining: ["--dry"] }];
    await capture(() => dispatchCommand("cle", ["cle", "--dry"]));
    expect(executeCalls.at(-1)).toEqual({ desc: { name: "cleanup" }, remaining: ["--dry"] });
    expect(exitCode).toBe(0);

    const p = plugin("rocket", { cliNames: { command: "rocket", aliases: [] } });
    plugins = [p];
    matchQueue = [null];
    resolveQueue = [{ kind: "none" }, { kind: "none" }, { kind: "match", plugin: p, matchedName: "rocket" }];
    invokeResult = { ok: true, output: "launched" };
    await capture(() => dispatchCommand("roc", ["roc", "now"]));
    expect(logs).toContain("launched");
    expect(invokeCalls.at(-1).ctx.args).toEqual(["now"]);
    expect(invokeCalls.at(-1).ctx.matchedName).toBe("rocket");
    expect(exitCode).toBe(0);

    plugins = [];
    matchQueue = [null];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    await capture(() => dispatchCommand("vers", ["vers"]));
    expect(logs).toEqual(["maw 1.2.3-test"]);
    expect(exitCode).toBe(0);

    matchQueue = [null];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    await capture(() => dispatchCommand("upg", ["upg", "--yes"]));
    expect(updateCalls).toEqual([["--yes"]]);
    expect(exitCode).toBe(0);
  });

  test("unique prefix plugin retries still validate flags with help text", async () => {
    const p = plugin("rocket", { cliNames: { command: "rocket", aliases: [] } });
    plugins = [p];
    matchQueue = [null];
    resolveQueue = [{ kind: "none" }, { kind: "none" }, { kind: "match", plugin: p, matchedName: "rocket" }];
    flagValidation = { ok: false, flag: "--verbse", suggestion: "--verbose" };

    const badFlag = await capture(() => dispatchCommand("roc", ["roc", "--verbse"]));

    expect(badFlag).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("unknown flag for rocket: --verbse");
    expect(errs.join("\n")).toContain("did you mean: --verbose");
    expect(errs.join("\n")).toContain("usage: maw rocket [flags]");
    expect(invokeCalls).toEqual([]);
  });

  test("unknown command suggestions avoid tmux, while oracle-shaped misses fall through to send/peek", async () => {
    plugins = [plugin("hello")];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    const typo = await capture(() => dispatchCommand("helo", ["helo"]));
    expect(typo).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("did you mean: hello");

    sessionsReturn = [{ name: "42-agent", windows: [] }];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    await dispatchCommand("agent", ["agent", "hi", "there", "--force"]);
    expect(sendCalls).toEqual([{ target: "agent", message: "hi there", force: true }]);

    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    await dispatchCommand("agent", ["agent"]);
    expect(peekCalls).toEqual(["agent"]);
  });

  test("oracle-shaped unknown commands consult sessions and fall through only on exact/stripped matches", async () => {
    sessionsReturn = [{ name: "42-xqneo", windows: [] }];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];

    await dispatchCommand("xqneo", ["xqneo", "status"]);

    expect(sendCalls).toEqual([{ target: "xqneo", message: "status", force: false }]);

    sessionsReturn = [{ name: "trinity", windows: [] }];
    resolveQueue = [{ kind: "none" }, { kind: "none" }];
    const unknown = await capture(() => dispatchCommand("xqmorpheus", ["xqmorpheus"]));

    expect(unknown).toBeInstanceOf(UserError);
    expect(errs.join("\n")).toContain("unknown command: xqmorpheus");
    expect(peekCalls).toEqual([]);
  });
});
