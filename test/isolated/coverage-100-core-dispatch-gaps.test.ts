import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { MawConfig } from "../../src/config";
import type { FleetEntry, FleetSession } from "../../src/commands/shared/fleet-load";
import type { Session } from "../../src/core/runtime/find-window";

process.env.MAW_CLI = "1";

let ghqRepos: string[] = [];
let fleetSessions: Record<string, string | null> = {};
let manifestEntries: Array<{ name: string; node?: string }> = [];
let manifestThrows = false;
let routeCommHandled = false;
let routeToolsHandled = false;
let aliasResult: unknown = null;
let directCalls: unknown[] = [];
let commandMatch: unknown = null;
let executeCalls: unknown[] = [];
let packages: any[] = [];
let pluginMatch: unknown = { kind: "none" };
let disabledPluginMatch: unknown = { kind: "none" };
let listCommandsValue: Array<{ name: string | string[] }> = [];
let invokedPlugins: unknown[] = [];
let dependencyStatusValue = { missing: [] as string[], disabled: [] as string[] };
let enablePlanValue: string[] = [];
let pluginNames: ((plugin: any) => { command: string; aliases: string[] } | null) | null = null;
let nonCliSurfacesValue: string[] = [];
let flagValidationValue: { ok: true } | { ok: false; flag: string; suggestion?: string } = { ok: true };
let sdkSessions: Array<{ name: string }> = [];
let peekCalls: string[] = [];
let sendCalls: Array<[string, string, boolean | undefined]> = [];
let updateCalls: string[][] = [];
let versionValue = "v-test";

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqList: async () => ghqRepos,
  ghqFind: async () => "",
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake"), () => ({
  resolveFleetSession: (oracle: string) => fleetSessions[oracle] ?? null,
}));

mock.module(import.meta.resolve("../../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => {
    if (manifestThrows) throw new Error("manifest unavailable");
    return manifestEntries;
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/comm"), () => ({
  cmdPeek: async (target: string) => { peekCalls.push(target); },
  cmdSend: async (target: string, message: string, force?: boolean) => { sendCalls.push([target, message, force]); },
}));
mock.module(import.meta.resolve("../../src/cli/route-comm"), () => ({ routeComm: async () => routeCommHandled }));
mock.module(import.meta.resolve("../../src/cli/route-tools"), () => ({ routeTools: async () => routeToolsHandled }));
mock.module(import.meta.resolve("../../src/cli/top-aliases"), () => ({
  resolveTopAlias: () => aliasResult,
  invokeDirectHandler: async (...args: unknown[]) => { directCalls.push(args); },
}));
mock.module(import.meta.resolve("../../src/cli/command-registry"), () => ({
  matchCommand: () => commandMatch,
  executeCommand: async (...args: unknown[]) => { executeCalls.push(args); },
  listCommands: () => listCommandsValue,
}));
mock.module(import.meta.resolve("../../src/plugin/registry"), () => ({
  discoverPackages: () => packages,
  invokePlugin: async (...args: unknown[]) => {
    invokedPlugins.push(args);
    return packages[0]?.invokeResult ?? { ok: true, output: "" };
  },
}));
mock.module(import.meta.resolve("../../src/cli/dispatch-match"), () => ({
  resolvePluginMatch: (_plugins: any[], _cmd: string, opts?: { includeDisabled?: boolean }) =>
    opts?.includeDisabled ? disabledPluginMatch : pluginMatch,
  pluginCliNames: (plugin: any) => pluginNames ? pluginNames(plugin) : plugin.cliNames,
  pluginNonCliSurfaces: () => nonCliSurfacesValue,
  validatePluginCliFlags: () => flagValidationValue,
}));
mock.module(import.meta.resolve("../../src/plugin/dependencies"), () => ({
  dependencyStatus: () => dependencyStatusValue,
  enablePlanFor: () => enablePlanValue,
}));
mock.module(import.meta.resolve("../../src/sdk"), () => ({
  listSessions: async () => sdkSessions,
  tmux: { run: async () => "" },
  FLEET_DIR: "/tmp/no-fleet",
}));
mock.module(import.meta.resolve("../../src/cli/cmd-version"), () => ({ getVersionString: () => versionValue }));
mock.module(import.meta.resolve("../../src/cli/cmd-update"), () => ({ runUpdate: async (args: string[]) => { updateCalls.push(args); } }));

const coreResolve = await import("../../src/core/resolve.ts?coverage-100-core-dispatch-gaps");
const routing = await import("../../src/core/routing.ts?coverage-100-core-dispatch-gaps");
const instancePid = await import("../../src/cli/instance-pid.ts?coverage-100-core-dispatch-gaps");
const fleetManage = await import("../../src/commands/shared/fleet-manage.ts?coverage-100-core-dispatch-gaps");
const dispatch = await import("../../src/cli/dispatch.ts?coverage-100-core-dispatch-gaps");

const original = {
  mawHome: process.env.MAW_HOME,
  cli: process.env.MAW_CLI,
  kill: process.kill,
  exit: process.exit,
  on: process.on,
  log: console.log,
  error: console.error,
};

let tempHome = "";
let logs: string[] = [];
let errors: string[] = [];
let exits: Array<number | undefined> = [];

beforeEach(() => {
  ghqRepos = [];
  fleetSessions = {};
  manifestEntries = [];
  manifestThrows = false;
  routeCommHandled = false;
  routeToolsHandled = false;
  aliasResult = null;
  directCalls = [];
  commandMatch = null;
  executeCalls = [];
  packages = [];
  pluginMatch = { kind: "none" };
  disabledPluginMatch = { kind: "none" };
  listCommandsValue = [];
  invokedPlugins = [];
  dependencyStatusValue = { missing: [], disabled: [] };
  enablePlanValue = [];
  pluginNames = null;
  nonCliSurfacesValue = [];
  flagValidationValue = { ok: true };
  sdkSessions = [];
  peekCalls = [];
  sendCalls = [];
  updateCalls = [];
  versionValue = "v-test";
  tempHome = mkdtempSync(join(tmpdir(), "maw-coverage-100-core-"));
  process.env.MAW_HOME = tempHome;
  process.env.MAW_CLI = "1";
  logs = [];
  errors = [];
  exits = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.exit = ((code?: number) => { exits.push(code); throw new Error(`exit:${code}`); }) as never;
});

afterEach(() => {
  if (original.mawHome === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = original.mawHome;
  if (original.cli === undefined) delete process.env.MAW_CLI; else process.env.MAW_CLI = original.cli;
  process.kill = original.kill;
  process.exit = original.exit;
  process.on = original.on;
  console.log = original.log;
  console.error = original.error;
  rmSync(tempHome, { recursive: true, force: true });
});

function config(overrides: Partial<MawConfig> = {}): MawConfig {
  return {
    host: "local",
    port: 3456,
    ghqRoot: "/gh",
    oracleUrl: "http://localhost:3456",
    env: {},
    commands: {},
    sessions: {},
    node: "m5",
    namedPeers: [{ name: "mba", url: "http://mba:3456" }],
    peers: ["http://legacy-node:3456"],
    agents: {},
    ...overrides,
  } as MawConfig;
}

function session(name: string, windows: Array<{ index: number; name: string }>, source?: string): Session & { source?: string } {
  return { name, windows: windows.map(w => ({ ...w, active: true })), source };
}

function fleetEntry(file: string, num: number, groupName: string, sessionName: string, peers: string[] = []): FleetEntry {
  const fleetSession: FleetSession = {
    name: sessionName,
    windows: [{ name: `${groupName}-oracle`, repo: `Soul-Brews-Studio/${groupName}-oracle` }],
    sync_peers: peers,
  };
  return { file, num, groupName, session: fleetSession };
}

function fleetDeps(entries: FleetEntry[], opts: { running?: string[]; exists?: (path: string) => boolean; tmuxFail?: boolean } = {}) {
  const writes: Array<[string, string]> = [];
  const renames: Array<[string, string]> = [];
  const unlinks: string[] = [];
  const tmuxRuns: string[][] = [];
  const localLogs: string[] = [];
  const deps = fleetManage.fleetManageDeps({
    loadFleetEntries: () => entries,
    getSessionNames: async () => opts.running ?? [],
    readdirSync: () => ["old.disabled", "note.txt"] as any,
    fleetDir: "/fleet",
    writeFile: async (path: string, contents: string) => { writes.push([path, contents]); },
    renameSync: (from: string, to: string) => { renames.push([from, to]); },
    existsSync: (path: string) => opts.exists?.(path) ?? true,
    unlinkSync: (path: string) => { unlinks.push(path); },
    join: (...parts: string[]) => parts.join("/"),
    tmuxRun: async (...args: string[]) => {
      tmuxRuns.push(args);
      if (opts.tmuxFail) throw new Error("tmux denied");
      return "";
    },
    log: (...args: unknown[]) => { localLogs.push(args.map(String).join(" ")); },
  } satisfies Partial<import("../../src/commands/shared/fleet-manage").FleetManageDeps>);
  return { deps, writes, renames, unlinks, tmuxRuns, localLogs };
}

describe("coverage-100 core resolve and routing dispatch gaps", () => {
  test("resolveOracle ranks pwd matches, normalizes numeric oracle names, and pickOracle handles invalid/end/error", async () => {
    ghqRepos = [
      "/gh/Other/neo-oracle",
      "/gh/Soul-Brews-Studio/neo-oracle",
      "/gh/Soul-Brews-Studio/not-an-oracle",
    ];

    await expect(coreResolve.resolveOracle("neo", {
      nameSpace: "session",
      matchPolicy: "exact",
    } as any)).resolves.toEqual({ kind: "not-found" });

    await expect(coreResolve.resolveOracle("neo", {
      nameSpace: "oracle",
      matchPolicy: "prefix",
      pwdHint: { owner: "Soul-Brews-Studio", repo: "neo-oracle" },
    })).resolves.toMatchObject({
      kind: "ambiguous",
      candidates: [
        { owner: "Soul-Brews-Studio", repo: "neo-oracle" },
        { owner: "Other", repo: "neo-oracle" },
      ],
    });

    await expect(coreResolve.resolveOracle("Soul-Brews-Studio/neo", {
      nameSpace: "any",
      matchPolicy: "prefix",
      repos: ghqRepos,
    })).resolves.toEqual({ kind: "exact", oracle: { owner: "Soul-Brews-Studio", repo: "neo-oracle", path: "/gh/Soul-Brews-Studio/neo-oracle" } });

    expect(await coreResolve.pickOracle([], { stream: { write: () => true } as any })).toBeNull();
    const reader = new EventEmitter() as NodeJS.ReadStream;
    (reader as any).resume = () => {};
    const picked = coreResolve.pickOracle([{ owner: "o", repo: "r-oracle" }], {
      stream: { write: () => true } as any,
      reader,
    });
    reader.emit("end");
    await expect(picked).resolves.toBeNull();
    await expect(coreResolve.pickOracle([{ owner: "o", repo: "r-oracle" }], {
      stream: { write: () => true } as any,
      reader: { on: () => { throw new Error("tty gone"); }, resume: () => {} } as any,
    })).resolves.toBeNull();

    expect(coreResolve._test.normalizedIntentNames(" 01-neo-oracle ")).toEqual(["01-neo-oracle", "01-neo", "neo-oracle", "neo"]);
  });

  test("resolveTarget covers writable filtering, fleet/session ambiguity, self-node, peers, manifest, and agent-map errors", () => {
    fleetSessions.neo = "01-neo";
    expect(routing.resolveTarget("neo", config(), [
      session("01-neo", [{ index: 0, name: "helper" }, { index: 1, name: "neo-oracle" }]),
      session("neo-view", [{ index: 0, name: "neo-oracle" }]),
      session("remote-neo", [{ index: 0, name: "neo-oracle" }], "peer"),
    ])).toEqual({ type: "local", target: "01-neo:1" });

    expect(routing.resolveTarget("neo", config(), [
      session("01-neo", [{ index: 0, name: "helper" }, { index: 1, name: "not-neo" }]),
    ])).toMatchObject({ type: "error", reason: "fleet_window_not_found" });

    expect(routing.resolveTarget("local:ghost", config({ node: "m5" }), [])).toMatchObject({ type: "error", reason: "self_not_running" });
    expect(routing.resolveTarget("m5:neo", config({ node: "m5" }), [
      session("02-neo", [{ index: 2, name: "neo-oracle" }]),
    ])).toEqual({ type: "self-node", target: "02-neo:2" });
    expect(routing.resolveTarget("mba:neo", config(), [])).toEqual({ type: "peer", peerUrl: "http://mba:3456", target: "neo", node: "mba" });
    expect(routing.resolveTarget("legacy-node:neo", config(), [])).toEqual({ type: "peer", peerUrl: "http://legacy-node:3456", target: "neo", node: "legacy-node" });
    expect(routing.resolveTarget(":neo", config(), [])).toMatchObject({ type: "error", reason: "empty_node_or_agent" });
    expect(routing.resolveTarget("unknown:neo", config(), [])).toMatchObject({ type: "error", reason: "unknown_node" });

    manifestThrows = true;
    expect(routing.resolveTarget("calliope", config(), [])).toMatchObject({ type: "error", reason: "not_found" });
    manifestThrows = false;
    manifestEntries = [{ name: "iris", node: "mba" }, { name: "localone", node: "m5" }, { name: "nowhere", node: "missing" }];
    expect(routing.resolveTarget("iris", config(), [])).toEqual({ type: "peer", peerUrl: "http://mba:3456", target: "iris", node: "mba" });
    expect(routing.resolveTarget("localone", config({ agents: { localone: "m5" } }), [])).toMatchObject({ type: "error", reason: "self_not_running" });
    expect(routing.resolveTarget("nowhere", config({ agents: { nowhere: "missing" } }), [])).toMatchObject({ type: "error", reason: "no_peer_url" });
    expect(routing.resolveTarget("ambig", config(), [
      session("10-ambig", [{ index: 1, name: "other" }]),
      session("11-ambig", [{ index: 2, name: "other" }]),
    ])).toMatchObject({ type: "error", reason: "session_alias_ambiguous" });
  });

  test("pid status and locks cover invalid files, stale locks, force takeover, stop paths, and signal cleanup", () => {
    writeFileSync(instancePid.pidFile(), "not-a-pid");
    expect(instancePid.serveStatus()).toEqual({ pid: null, alive: false, file: instancePid.pidFile() });

    writeFileSync(instancePid.pidFile(), "4242");
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) {
        const err = new Error("missing") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      throw new Error(`unexpected kill ${pid}`);
    }) as typeof process.kill;
    instancePid.stopServe();
    expect(logs.join("\n")).toContain("removed stale PID 4242");

    logs = [];
    expect(instancePid.serveStatus().pid).toBeNull();
    instancePid.stopServe();
    expect(logs.join("\n")).toContain("already stopped");

    writeFileSync(instancePid.pidFile(), "5151");
    const kills: Array<[number, string | number | undefined]> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      if (signal === 0) return true;
      return true;
    }) as typeof process.kill;
    instancePid.stopServe();
    expect(kills).toContainEqual([5151, "SIGTERM"]);
    expect(logs.join("\n")).toContain("stopped PID 5151");

    writeFileSync(instancePid.pidFile(), "6161");
    kills.length = 0;
    instancePid.acquirePidLock("neo", { forceTakeover: true });
    expect(kills).toContainEqual([6161, "SIGTERM"]);
    expect(readFileSync(instancePid.pidFile(), "utf-8")).toBe(String(process.pid));

    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    process.on = ((event: string, listener: (...args: any[]) => void) => {
      (handlers[event] ??= []).push(listener);
      return process;
    }) as typeof process.on;
    rmSync(instancePid.pidFile(), { force: true });
    instancePid.acquirePidLock(null);
    expect(() => handlers.exit.at(-1)?.()).not.toThrow();
    expect(instancePid.serveStatus().pid).toBeNull();
  });

  test("fleet management renders invalid rows and covers rename/renumber dry-run, force, cleanup, and tmux-fail paths", async () => {
    const malformed = { file: "broken.json", num: 7, groupName: "broken", session: { windows: "bad" } as any };
    const rendered = fleetManage.renderFleetLs([
      fleetEntry("01-neo.json", 1, "neo", "01-neo"),
      fleetEntry("01-other.json", 1, "other", "01-other"),
      malformed,
    ], 2, ["01-neo"]);
    expect(rendered.join("\n")).toContain("CONFLICT");
    expect(rendered.join("\n")).toContain("INVALID");

    const entries = [
      fleetEntry("01-neo.json", 1, "neo", "01-neo"),
      fleetEntry("02-peer.json", 2, "peer", "02-peer", ["neo", "01-neo"]),
    ];
    const dry = fleetDeps(entries, { running: ["01-neo"], exists: (path) => path.endsWith("01-neo.json") });
    await expect(fleetManage.cmdFleetRename({ oldName: "neo.json", newName: "neo-new", dryRun: true }, dry.deps)).rejects.toThrow("referenced by sync_peers");
    await fleetManage.cmdFleetRename({ oldName: "neo.json", newName: "neo-new", dryRun: true, force: true }, dry.deps);
    expect(dry.localLogs.join("\n")).toContain("leaving sync_peers");
    expect(dry.localLogs.join("\n")).toContain("would tmux rename");
    expect(dry.writes).toHaveLength(0);

    await expect(fleetManage.cmdFleetRename({ oldName: "../bad", newName: "ok" }, dry.deps)).rejects.toThrow("invalid old fleet name");
    await expect(fleetManage.cmdFleetRename({ oldName: "neo", newName: "neo" }, dry.deps)).rejects.toThrow("identical");
    await expect(fleetManage.cmdFleetRename({ oldName: "missing", newName: "new" }, dry.deps)).rejects.toThrow("fleet not found");

    const write = fleetDeps([fleetEntry("09-gamma.json", 9, "gamma", "09-gamma")], {
      running: ["gamma"],
      tmuxFail: true,
      exists: (path) => path.endsWith("09-gamma.json"),
    });
    await fleetManage.cmdFleetRename({ oldName: "gamma", newName: "02-gamma" }, write.deps);
    expect(write.renames).toContainEqual(["/fleet/.tmp-02-gamma.json", "/fleet/02-gamma.json"]);
    expect(write.unlinks).toContain("/fleet/09-gamma.json");
    expect(write.localLogs.join("\n")).toContain("tmux rename failed");

    const clean = fleetDeps([fleetEntry("01-clean.json", 1, "clean", "01-clean")]);
    await fleetManage.cmdFleetRenumber(clean.deps);
    expect(clean.localLogs.join("\n")).toContain("No conflicts found");

    const conflict = fleetDeps([
      fleetEntry("02-beta.json", 2, "beta", "02-beta"),
      fleetEntry("02-alpha.json", 2, "alpha", "02-alpha"),
      fleetEntry("99-overview.json", 99, "overview", "99-overview"),
    ], { running: ["alpha", "02-beta"] });
    await fleetManage.cmdFleetRenumber(conflict.deps);
    expect(conflict.writes.map(([path]) => path)).toEqual(["/fleet/.tmp-01-alpha.json"]);
    expect(conflict.localLogs.join("\n")).toContain("02-alpha.json");
    expect(conflict.localLogs.join("\n")).toContain("02-beta.json                   (unchanged)");
  });

  test("dispatch covers aliases, dependency/flag failures, disabled/headless commands, prefix retries, and oracle shorthand", async () => {
    aliasResult = { kind: "direct", handler: "h", argv: ["x"] };
    await dispatch.dispatchCommand("anything", ["anything"]);
    expect(directCalls).toEqual([["h", ["x"]]]);

    aliasResult = { kind: "rewrite", argv: ["real", "--flag"] };
    commandMatch = { desc: { name: "real" }, remaining: ["--flag"] };
    await dispatch.dispatchCommand("alias", ["alias"]);
    expect(executeCalls).toEqual([[{ name: "real" }, ["--flag"]]]);

    aliasResult = null;
    commandMatch = null;
    packages = [{ manifest: { name: "plug", cli: { help: "maw plug [--ok]" } }, cliNames: { command: "plug", aliases: ["pl"] } }];
    pluginMatch = { kind: "match", matchedName: "plug", plugin: packages[0] };
    dependencyStatusValue = { missing: ["dep-a"], disabled: [] };
    await expect(dispatch.dispatchCommand("plug", ["plug"])).rejects.toThrow("missing plugin dependency");
    dependencyStatusValue = { missing: [], disabled: ["dep-b"] };
    await expect(dispatch.dispatchCommand("plug", ["plug"])).rejects.toThrow("disabled plugin dependency");
    dependencyStatusValue = { missing: [], disabled: [] };
    flagValidationValue = { ok: false, flag: "--bad", suggestion: "--ok" };
    await expect(dispatch.dispatchCommand("plug", ["plug", "--bad"])).rejects.toThrow("unknown flag");

    flagValidationValue = { ok: true };
    packages[0].invokeResult = { ok: true, output: "plugin ok" };
    await expect(dispatch.dispatchCommand("plug", ["plug", "arg"])).rejects.toThrow("exit:0");
    expect(logs).toContain("plugin ok");
    expect(invokedPlugins.at(-1)).toEqual([packages[0], { source: "cli", args: ["arg"], matchedName: "plug" }]);

    logs = [];
    packages[0].invokeResult = { ok: false, error: "plugin failed", exitCode: 7 };
    await expect(dispatch.dispatchCommand("plug", ["plug"])).rejects.toThrow("exit:7");
    expect(errors).toContain("plugin failed");

    pluginMatch = { kind: "none" };
    disabledPluginMatch = { kind: "match", plugin: { manifest: { name: "sleep" }, cliNames: { command: "sleep", aliases: [] } } };
    enablePlanValue = ["sleep", "dep"];
    await expect(dispatch.dispatchCommand("sleep", ["sleep"])).rejects.toThrow("disabled command");
    disabledPluginMatch = { kind: "ambiguous", candidates: [{ plugin: "a" }, { plugin: "b" }] };
    await expect(dispatch.dispatchCommand("s", ["s"])).rejects.toThrow("disabled command");

    disabledPluginMatch = { kind: "none" };
    packages = [{ disabled: false, manifest: { name: "headless" }, cliNames: null }];
    pluginNames = () => null;
    nonCliSurfacesValue = ["api", "hooks"];
    await expect(dispatch.dispatchCommand("headless", ["headless"])).rejects.toThrow("headless plugin");

    pluginNames = null;
    packages = [];
    listCommandsValue = [{ name: ["version"] }, { name: "update" }, { name: "cleanup" }];
    await expect(dispatch.dispatchCommand("v", ["v"])).rejects.toThrow("exit:0");
    expect(logs.at(-1)).toBe("v-test");
    await expect(dispatch.dispatchCommand("upd", ["upd", "--check"])).rejects.toThrow("exit:0");
    expect(updateCalls).toEqual([["--check"]]);

    errors = [];
    await expect(dispatch.dispatchCommand("u", ["u"])).rejects.toThrow("unknown command");
    expect(errors.join("\n")).toContain("did you mean");

    sdkSessions = [{ name: "03-zz-agent" }];
    await dispatch.dispatchCommand("zz-agent", ["zz-agent"]);
    expect(peekCalls).toEqual(["zz-agent"]);
    await dispatch.dispatchCommand("zz-agent", ["zz-agent", "hi", "--force"]);
    expect(sendCalls).toEqual([["zz-agent", "hi", true]]);
  });
});
