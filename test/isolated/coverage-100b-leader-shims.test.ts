import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

let configNode: string | undefined = "m5";
let published: Array<[string, unknown]> = [];
let discovered: any[] = [];
let viewFiles = new Map<string, string>();

mock.module("fs", () => ({
  ...realFs,
  existsSync: (path: string) => viewFiles.has(path) || realFs.existsSync(path),
  readFileSync: (path: string, encoding?: BufferEncoding) => {
    if (viewFiles.has(path)) return viewFiles.get(path) as never;
    return realFs.readFileSync(path, encoding as never) as never;
  },
}));

mock.module(import.meta.resolve("../../src/core/paths"), () => ({
  MAW_ROOT: "/tmp/maw-coverage-root",
  resolveHome: () => "/tmp/maw-coverage-home",
  CONFIG_DIR: "/tmp/maw-coverage-home/config",
  FLEET_DIR: "/tmp/maw-coverage-home/config/fleet",
  CONFIG_FILE: "/tmp/maw-coverage-home/config/maw.config.json",
}));
mock.module(import.meta.resolve("../../src/config"), () => ({
  D: { limits: {}, intervals: {}, timeouts: {} },
  loadConfig: () => ({ node: configNode, engines: {}, agents: {}, peers: [] }),
  resetConfig: () => {},
  saveConfig: () => {},
  configForDisplay: () => ({}),
  cfgInterval: () => 0,
  cfgTimeout: () => 0,
  cfgLimit: () => 0,
  cfg: () => undefined,
  validateConfigShape: () => ({ ok: true }),
  buildCommand: () => "",
  buildCommandInDir: () => "",
  getEnvVars: () => ({}),
}));
mock.module(import.meta.resolve("../../src/mqtt-publish"), () => ({
  mqttPublish: (topic: string, payload: unknown) => { published.push([topic, payload]); },
}));
mock.module(import.meta.resolve("../../src/plugin/registry"), () => ({
  discoverPackages: () => discovered,
  resetDiscoverCache: () => {},
  invokePlugin: async () => ({ ok: true, output: "" }),
  importPluginSymbol: async () => undefined,
  satisfies: () => true,
  formatSdkMismatchError: () => "",
  runtimeSdkVersion: () => "0.0.0",
  hashFile: async () => "0".repeat(64),
  isDevModeInstall: () => false,
  __resetDiscoverStateForTests: () => {},
}));

const tempDir = mkdtempSync(join(tmpdir(), "maw-coverage-hooks-"));
const hookModulePath = join(tempDir, "hook-entry.ts");
writeFileSync(hookModulePath, `
export function gate() { return true; }
export function onFilter(event) { return event; }
export function handle() {}
export function cleanup() {}
`);
const hookModuleUrl = pathToFileURL(hookModulePath).href;

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

beforeEach(() => {
  configNode = "m5";
  published = [];
  discovered = [];
  viewFiles = new Map();
});

describe("coverage shims and tiny runtime branches", () => {
  test("loads export-only plugin shims so their runtime re-export lines enter LCOV", async () => {
    const fleetInit = await import("../../src/commands/plugins/fleet/fleet-init.ts?coverage-100b-leader");
    const oracleMembers = await import("../../src/commands/plugins/team/oracle-members.ts?coverage-100b-leader");
    const taskOps = await import("../../src/commands/plugins/team/task-ops.ts?coverage-100b-leader");
    const cleanup = await import("../../src/commands/plugins/team/team-cleanup.ts?coverage-100b-leader");
    const invite = await import("../../src/commands/plugins/team/team-invite.ts?coverage-100b-leader");

    expect(typeof fleetInit.cmdFleetInit).toBe("function");
    expect(typeof fleetInit.cmdFleetInitAgents).toBe("function");
    expect(typeof oracleMembers.cmdOracleInvite).toBe("function");
    expect(typeof oracleMembers.cmdOracleRemove).toBe("function");
    expect(typeof oracleMembers.cmdOracleMembers).toBe("function");
    expect(typeof taskOps.cmdTeamTaskAdd).toBe("function");
    expect(typeof taskOps.cmdTeamTaskList).toBe("function");
    expect(typeof taskOps.cmdTeamTaskDone).toBe("function");
    expect(typeof taskOps.cmdTeamTaskAssign).toBe("function");
    expect(typeof cleanup.cmdTeamDelete).toBe("function");
    expect(typeof invite.cmdTeamInvite).toBe("function");
  });

  test("serves generated office views when the built html exists", async () => {
    viewFiles.set("/tmp/maw-coverage-root/office/federation.html", "<h1>federation</h1>");
    viewFiles.set("/tmp/maw-coverage-root/office/timemachine.html", "<h1>time</h1>");

    const { federationView } = await import("../../src/views/federation.ts?coverage-100b-leader");
    const { timemachineView } = await import("../../src/views/timemachine.ts?coverage-100b-leader");

    const fed = await federationView.request("/");
    const time = await timemachineView.request("/");

    expect(fed.status).toBe(200);
    expect(await fed.text()).toContain("federation");
    expect(time.status).toBe(200);
    expect(await time.text()).toContain("time");
  });

  test("mqtt builtin registers a feed publisher when node and mqtt module exist", async () => {
    const callbacks: Array<(event: { oracle: string; type: string }) => void> = [];
    const plugin = (await import("../../src/plugins/builtin/mqtt-publish.ts?coverage-100b-leader")).default;

    plugin({ on: (_event: string, fn: (event: { oracle: string; type: string }) => void) => callbacks.push(fn) } as never);
    callbacks[0]({ oracle: "mawjs", type: "test" });

    expect(published).toEqual([
      ["maw/v1/oracle/mawjs/feed", { oracle: "mawjs", type: "test" }],
      ["maw/v1/node/m5/feed", { oracle: "mawjs", type: "test" }],
    ]);
  });

  test("manifest hook registry supports systems without plugin context", async () => {
    discovered = [{
      manifest: { name: "hooks", hooks: { gate: ["ready"], filter: ["feed"], on: ["feed"], late: ["done"] } },
      kind: "ts",
      entryPath: hookModuleUrl,
    }];
    const calls: Array<[string, string]> = [];
    const registered: Array<[string, string, string]> = [];
    const system = {
      hooks: {
        gate: (event: string) => calls.push(["gate", event]),
        filter: (event: string) => calls.push(["filter", event]),
        on: (event: string) => calls.push(["on", event]),
        late: (event: string) => calls.push(["late", event]),
      },
      register: (...args: [string, string, string]) => registered.push(args),
    };

    const { registerManifestHooks } = await import("../../src/plugins/30_hooks-registry.ts?coverage-100b-leader");

    expect(await registerManifestHooks(system as never)).toBe(4);
    expect(calls).toEqual([["gate", "ready"], ["filter", "feed"], ["on", "feed"], ["late", "done"]]);
    expect(registered).toEqual([["hooks", "ts", "user"]]);
  });
});
