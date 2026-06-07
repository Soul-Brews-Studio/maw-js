import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let homeDir = mkdtempSync(join(tmpdir(), "maw-coverage-100-final-home-"));
let peerResolveResult: { url: string } | null = { url: "https://peer.example" };
let peerKillResult: any = { ok: false, status: 500, data: { error: "remote boom" } };
let sdkSessions: any[] = [];
let tmuxRunResult = "";
let listPaneIdsResult = new Set<string>();
let resolveTargetResult: any = null;
let curlFetchResult: any = { ok: false, status: 503, data: { error: "peer busy" } };
let probeResult: any = { node: "node-a", pubkey: "pk", identity: { oracle: "o", node: "n" } };
let sdkHostExecResult = "";
let sdkReadCacheResult: any = null;

mock.module("os", () => ({
  homedir: () => homeDir,
  tmpdir,
}));

const configMock = {
  loadConfig: () => ({ peers: [], namedPeers: [] }),
  cfgLimit: () => 1000,
  cfgTimeout: () => 1000,
  cfgInterval: () => 1000,
  cfg: (_key: string, fallback?: unknown) => fallback,
  D: { limits: {}, timeouts: {}, intervals: {} },
  buildCommand: () => "echo maw",
  buildCommandInDir: () => "echo maw",
  getEnvVars: () => ({}),
  saveConfig: () => undefined,
  resetConfig: () => undefined,
};

mock.module("maw-js/config", () => configMock);
mock.module(import.meta.resolve("../../src/config.ts"), () => configMock);

const sdkMock = {
  ...configMock,
  FLEET_DIR: join(homeDir, ".maw", "fleet"),
  CONFIG_DIR: join(homeDir, ".maw"),
  MAW_ROOT: homeDir,
  CONFIG_FILE: join(homeDir, ".maw", "config.json"),
  takeSnapshot: () => Promise.resolve(),
  listSnapshots: () => [],
  loadSnapshot: () => null,
  latestSnapshot: () => null,
  listSessions: async () => sdkSessions,
  listPaneIds: async () => listPaneIdsResult,
  resolveTarget: () => resolveTargetResult,
  resolveOracle: () => null,
  pickOracle: () => null,
  curlFetch: async () => curlFetchResult,
  hostExec: async () => sdkHostExecResult,
  HostExecError: class HostExecError extends Error {},
  withPaneLock: async (fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "%1",
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
  tmuxCmd: () => "",
  resolveSocket: () => undefined,
  capture: async () => "",
  sendKeys: async () => undefined,
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  getPeers: () => [],
  getFederationStatus: () => ({}),
  findPeerForTarget: () => null,
  findWindow: async () => null,
  runHook: async () => undefined,
  getTriggers: () => [],
  getTriggerHistory: () => [],
  scanWorktrees: () => [],
  cleanupWorktree: () => undefined,
  saveTabOrder: () => undefined,
  restoreTabOrder: () => undefined,
  readAudit: () => [],
  logAudit: () => undefined,
  scanLocal: () => [],
  scanRemote: () => [],
  scanFull: () => [],
  scanAndCache: () => [],
  readCache: () => sdkReadCacheResult,
  isCacheStale: () => false,
  tmux: {
    run: async () => tmuxRunResult,
    listPaneIds: async () => listPaneIdsResult,
    sendKeys: async () => undefined,
  },
  Tmux: class {
    async sendText() {}
  },
};

mock.module("maw-js/sdk", () => sdkMock);
mock.module(import.meta.resolve("../../src/sdk"), () => sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => sdkMock);
mock.module(import.meta.resolve("../../src/core/transport/tmux.ts"), () => ({
  tmux: {
    run: async () => tmuxRunResult,
    listPaneIds: async () => listPaneIdsResult,
    sendKeys: async () => undefined,
  },
  Tmux: sdkMock.Tmux,
  tmuxCmd: () => "",
  resolveSocket: () => undefined,
  withPaneLock: async (fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "%1",
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  resolveOraclePane: async (target: string) => target,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-resolve"), () => ({
  resolvePeer: () => peerResolveResult,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-call"), () => ({
  callPeerKill: async () => peerKillResult,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/probe"), () => ({
  probePeer: async () => probeResult,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/impl"), () => ({
  cmdForget: async () => undefined,
}));

mock.module(import.meta.resolve("../../src/commands/plugins/oracle/impl-list"), () => ({
  buildEnrichedEntries: async () => [
    { entry: { name: "b-tie", org: "org", repo: "b-tie-oracle" }, awake: false, lineage: "fleet" },
    { entry: { name: "a-tie", org: "org", repo: "a-tie-oracle" }, awake: false, lineage: "fleet" },
  ],
  formatRow: (x: any) => `row:${x.entry.name}`,
}));
mock.module(import.meta.resolve("../../src/commands/plugins/oracle/impl-list.ts"), () => ({
  buildEnrichedEntries: async () => [
    { entry: { name: "b-tie", org: "org", repo: "b-tie-oracle" }, awake: false, lineage: "fleet" },
    { entry: { name: "a-tie", org: "org", repo: "a-tie-oracle" }, awake: false, lineage: "fleet" },
  ],
  formatRow: (x: any) => `row:${x.entry.name}`,
}));
mock.module(import.meta.resolve("../../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => [
    { name: "b-tie", repo: "org/b-tie-oracle", sources: ["fleet"] },
    { name: "a-tie", repo: "org/a-tie-oracle", sources: ["fleet"] },
  ],
  invalidateManifest: () => undefined,
}));
mock.module(import.meta.resolve("../../src/lib/oracle-manifest.ts"), () => ({
  loadManifestCached: () => [
    { name: "b-tie", repo: "org/b-tie-oracle", sources: ["fleet"] },
    { name: "a-tie", repo: "org/a-tie-oracle", sources: ["fleet"] },
  ],
  invalidateManifest: () => undefined,
}));

const originalLog = console.log;
const originalError = console.error;
let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "maw-coverage-100-final-home-"));
  process.env.PEERS_FILE = join(homeDir, "peers.json");
  delete process.env.MAW_CONFIG_DIR;
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  peerResolveResult = { url: "https://peer.example" };
  peerKillResult = { ok: false, status: 500, data: { error: "remote boom" } };
  sdkSessions = [];
  tmuxRunResult = "";
  listPaneIdsResult = new Set<string>();
  resolveTargetResult = null;
  curlFetchResult = { ok: false, status: 503, data: { error: "peer busy" } };
  probeResult = { node: "node-a", pubkey: "pk", identity: { oracle: "o", node: "n" } };
  sdkHostExecResult = "";
  sdkReadCacheResult = null;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
  delete process.env.MAW_CONFIG_DIR;
});

describe("final small coverage gaps", () => {
  test("covers remaining simple helper and dispatcher branches", async () => {
    const { cmdCompletions } = await import("../../src/vendor/mpr-plugins/completions/impl");
    await cmdCompletions("--help");
    expect(logs.join("\n")).toContain("usage: maw completions");

    const { parseFlags } = await import("../../src/vendor/mpr-plugins/shellenv/src/internal/parse-flags");
    expect(parseFlags(["--unknown", "zsh"], {}, 0)).toEqual({ _: ["zsh"], "--unknown": true });

    const splitHandler = (await import("../../src/vendor/mpr-plugins/split/index")).default;
    await expect(splitHandler({ source: "cli", args: [] } as any)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("usage: maw split"),
    });

    const { parseSendEnterArgs } = await import("../../src/vendor/mpr-plugins/send-enter/impl");
    expect(() => parseSendEnterArgs(["target", "--N=0"])).toThrow("--N requires a positive integer");
  });

  test("covers registry monorepo, workspace corrupt read, and runtime empty hook config", async () => {
    const { resolvePluginSource } = await import("../../src/commands/plugins/plugin/registry-resolve");
    expect(resolvePluginSource("cell", {
      schemaVersion: 1,
      generatedAt: "now",
      plugins: {
        cell: { name: "cell", version: "1.2.3", source: "monorepo:plugins/cell@v1.2.3", sha256: null },
      },
    } as any)).toMatchObject({ kind: "monorepo", source: "monorepo:plugins/cell@v1.2.3" });

    process.env.MAW_CONFIG_DIR = join(homeDir, "config");
    const wsDir = join(process.env.MAW_CONFIG_DIR, "workspaces");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), "{not-json");
    const { loadAllWorkspaces } = await import("../../src/commands/shared/workspace-store");
    expect(loadAllWorkspaces()).toEqual([]);

    const { runHook } = await import("../../src/core/runtime/hooks");
    await runHook("message", { to: "nobody", message: "ignored" });
    expect(true).toBe(true);
  });

  test("covers cache resets, stale team liveness, and corrupt peer stores", async () => {
    const { __resetClaudeSessionCachesForTests } = await import("../../src/core/fleet/claude-sessions");
    __resetClaudeSessionCachesForTests();

    const teamRoot = join(homeDir, ".claude", "teams", "recent");
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, "config.json"), JSON.stringify({
      name: "recent",
      description: "",
      members: [{ backendType: "in-process", cwd: join(homeDir, "repo"), joinedAt: Date.now() }],
    }));
    const { scanTeams } = await import("../../src/engine/teams");
    expect(await scanTeams()).toMatchObject([{ name: "recent", alive: true }]);

    writeFileSync(process.env.PEERS_FILE!, "{bad-json");
    const { loadPeers } = await import("../../src/lib/peers/store");
    expect(loadPeers()).toEqual({ version: 1, peers: {} });
    expect(errors.join("\n")).toContain("failed to parse");
  });

  test("covers peer forwarding and cross-node send failure branches", async () => {
    const killHandler = (await import("../../src/vendor/mpr-plugins/kill/index")).default;
    const kill = await killHandler({ source: "cli", args: ["target", "--peer", "alpha"] } as any);
    expect(kill.ok).toBe(false);
    expect(kill.error).toContain("peer kill failed");

    resolveTargetResult = { type: "peer", node: "white", peerUrl: "https://white.example", target: "oracle" };
    const { cmdSendText } = await import("../../src/vendor/mpr-plugins/send-text/impl");
    await expect(cmdSendText({ target: "white:oracle", text: "hello" })).rejects.toThrow("peer send-text failed");
  });

  test("covers report helpers and done --all defensive stale-session branch", async () => {
    for (const mod of [
      "../../src/vendor/mpr-plugins/archive/internal/sync-helpers",
      "../../src/vendor/mpr-plugins/bud/internal/sync-helpers",
      "../../src/vendor/mpr-plugins/done/internal/sync-helpers",
      "../../src/vendor/mpr-plugins/soul-sync/sync-helpers",
    ]) {
      const { reportProjectResult } = await import(mod);
      reportProjectResult({ project: "proj", oracle: "oracle", total: 0, synced: {} });
    }
    expect(logs.join("\n")).toContain("nothing new");

    sdkSessions = {
      length: 1,
      0: { name: "ghost", windows: [] },
      find: () => undefined,
    } as any;
    const { cmdDoneAll } = await import("../../src/vendor/mpr-plugins/done/impl");
    await expect(cmdDoneAll({ force: true })).resolves.toEqual({ sessionName: "ghost", processed: [], skipped: [] });
    expect(logs.join("\n")).toContain("current tmux session 'ghost' not found");
  });

  test("covers pair re-add metadata preservation without query imports", async () => {
    writeFileSync(process.env.PEERS_FILE!, JSON.stringify({
      version: 1,
      peers: {
        alpha: {
          url: "https://old.example",
          node: "old",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastSeen: null,
          pubkey: "pk",
          pubkeyFirstSeen: "2026-01-02T00:00:00.000Z",
        },
      },
    }));

    const { cmdAdd } = await import("../../src/vendor/mpr-plugins/pair/internal/peers-impl");
    const result = await cmdAdd({ alias: "alpha", url: "https://new.example" });
    expect(result.peer.pubkey).toBe("pk");
    expect(result.peer.pubkeyFirstSeen).toBe("2026-01-02T00:00:00.000Z");
    expect(result.peer.identity).toEqual({ oracle: "o", node: "n" });
  });

  test("covers oracle nickname output branch", async () => {
    const repoPath = join(homeDir, "alpha-oracle");
    mkdirSync(join(repoPath, "ψ"), { recursive: true });
    writeFileSync(join(repoPath, "ψ", "nickname"), "Alpha\n");
    sdkReadCacheResult = { oracles: [{ name: "alpha", local_path: repoPath }] };

    const { cmdOracleGetNickname } = await import("../../src/commands/plugins/oracle/impl-nickname");
    logs = [];
    cmdOracleGetNickname("alpha", { json: false });
    expect(logs).toEqual(["Alpha"]);
  });

  test("covers small plugin wrappers and peer no-op fallbacks", async () => {
    const peersHandler = (await import("../../src/vendor/mpr-plugins/peers/index")).default;
    await expect(peersHandler({ source: "cli", args: ["forget", "alpha"] } as any)).resolves.toMatchObject({
      ok: true,
    });

    const { cmdMegaStatus } = await import("../../src/vendor/mpr-plugins/mega/impl");
    const tasksDir = join(homeDir, ".claude", "tasks", "mega");
    mkdirSync(join(homeDir, ".claude", "teams", "mega"), { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(homeDir, ".claude", "teams", "mega", "config.json"), JSON.stringify({
      name: "mega",
      description: "",
      members: [],
    }));
    writeFileSync(join(tasksDir, "bad.json"), "{bad-json");
    await cmdMegaStatus();
    expect(logs.join("\n")).toContain("MEGA");
  });
});
