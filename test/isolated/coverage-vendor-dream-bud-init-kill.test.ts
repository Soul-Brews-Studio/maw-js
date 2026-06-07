import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

let bootstrapError: Error | null = null;
let writeCalls: unknown[] = [];
let buildConfigCalls: unknown[] = [];
let initOutput: string[] = [];
let killHostExecCalls: string[] = [];
let killErrors: string[] = [];
let killPaneListReject = false;

mock.module("os", () => ({
  homedir: () => "/Users/tester",
  hostname: () => "white",
}));

mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => [],
}));

mock.module("maw-js/core/paths", () => ({
  CONFIG_FILE: "/tmp/maw.config.json",
  FLEET_DIR: "/tmp/fleet",
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => "/tmp/fleet",
  loadFleetEntries: () => [],
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/prompts"), () => ({
  ttyAsk: async () => "",
  runPromptLoop: async () => ({
    node: "white",
    token: "",
    federate: false,
    peers: [],
  }),
  validateNodeName: () => null,
  validatePeerName: () => null,
  validatePeerUrl: () => null,
  validateGhqRoot: () => null,
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/write-config"), () => ({
  buildConfig: (input: unknown) => {
    buildConfigCalls.push(input);
    return { node: "white", built: true };
  },
  configExists: () => false,
  backupConfig: () => "/tmp/maw.config.json.bak",
  writeConfigAtomic: (path: string, config: unknown, overwrite: boolean) => {
    writeCalls.push({ path, config, overwrite });
  },
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/federation"), () => ({
  generateFederationToken: () => "token-unused",
}));

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/bootstrap-plugins-lock"), () => ({
  bootstrapPluginsLock: () => {
    if (bootstrapError) throw bootstrapError;
    return { created: false, path: "/tmp/plugins.lock" };
  },
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [],
  tmuxCmd: () => "tmux",
  hostExec: async (command: string) => {
    killHostExecCalls.push(command);
    if (command.includes("list-panes -a -F")) {
      if (killPaneListReject) throw new Error("pane list unavailable");
      return [
        "%101|||session:0.0|||ghost|||role-a|||/tmp/work-a",
        "%102|||session:0.1|||ghost|||role-b|||/tmp/work-b",
      ].join("\n");
    }
    throw new Error(`unexpected hostExec command: ${command}`);
  },
}));

const { cmdInit } = await import("../../src/vendor/mpr-plugins/init/impl.ts?coverage-vendor-dream-bud-init-kill");
const { cmdKill } = await import("../../src/vendor/mpr-plugins/kill/impl.ts?coverage-vendor-dream-bud-init-kill");

const originalError = console.error;

beforeEach(() => {
  bootstrapError = null;
  writeCalls = [];
  buildConfigCalls = [];
  initOutput = [];
  killHostExecCalls = [];
  killErrors = [];
  killPaneListReject = false;
  console.error = (...args: unknown[]) => {
    killErrors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = originalError;
});

describe("init and kill edge coverage", () => {
  test("interactive init reports bootstrap lock warnings without failing setup", async () => {
    bootstrapError = new Error("lock directory unavailable");

    const result = await cmdInit({
      args: [],
      writer: (message) => initOutput.push(message),
    });

    expect(result).toEqual({
      ok: true,
      configPath: "/tmp/maw.config.json",
      config: { node: "white", built: true },
    });
    expect(buildConfigCalls).toHaveLength(1);
    expect(writeCalls).toEqual([
      { path: "/tmp/maw.config.json", config: { node: "white", built: true }, overwrite: true },
    ]);
    expect(initOutput.join("\n")).toContain("plugins.lock bootstrap skipped — lock directory unavailable");
  });

  test("kill reports ambiguous pane-title fallback matches before issuing a destructive tmux command", async () => {
    await expect(cmdKill("ghost")).rejects.toThrow("'ghost' is ambiguous");

    expect(killHostExecCalls).toHaveLength(1);
    expect(killHostExecCalls[0]).toContain("list-panes -a -F");
    expect(killHostExecCalls.some((command) => command.includes("kill-pane"))).toBe(false);
    const rendered = killErrors.join("\n");
    expect(rendered).toContain("ghost' is ambiguous");
    expect(rendered).toContain("%101");
    expect(rendered).toContain("%102");
  });

  test("kill falls through to not-found when pane fallback listing is unavailable", async () => {
    killPaneListReject = true;

    await expect(cmdKill("lost")).rejects.toThrow("session 'lost' not found");

    expect(killHostExecCalls).toHaveLength(1);
    expect(killHostExecCalls[0]).toContain("list-panes -a -F");
    expect(killHostExecCalls.some((command) => command.includes("kill-pane"))).toBe(false);
    expect(killErrors.join("\n")).toContain("session 'lost' not found");
  });
});
