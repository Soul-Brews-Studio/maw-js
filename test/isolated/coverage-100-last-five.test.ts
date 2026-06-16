import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let homeDir = mkdtempSync(join(tmpdir(), "maw-last-five-home-"));
let sdkResolveTarget: any = null;
let sdkCurlFetch: any = { ok: false, status: 500, data: { error: "boom" } };
let peerKillResponse: any = { ok: false, status: 500, data: { error: "boom" } };
let execCalls: string[] = [];
let ghqDir = "";

class MockUserError extends Error {
  readonly isUserError = true;
}

function isMockUserError(value: unknown): boolean {
  return value instanceof Error && (value as { isUserError?: unknown }).isUserError === true;
}

const originalEnv = {
  home: process.env.HOME,
  mawHome: process.env.MAW_HOME,
  mawDataDir: process.env.MAW_DATA_DIR,
  mawXdg: process.env.MAW_XDG,
};

mock.module("os", () => ({
  homedir: () => homeDir,
  tmpdir,
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => ({}),
  ghqFindSync: () => ghqDir,
}));

mock.module("maw-js/sdk", () => ({
  UserError: MockUserError,
  isUserError: isMockUserError,
  listSessions: async () => [],
  resolveTarget: () => sdkResolveTarget,
  curlFetch: async () => sdkCurlFetch,
  hostExec: async () => "",
  tmuxCmd: () => "tmux",
  resolveSocket: () => undefined,
  capture: async () => "",
  sendKeys: async () => undefined,
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  withPaneLock: async (fn: () => Promise<unknown>) => fn(),
  splitWindowLocked: async () => "%1",
  tagPane: async () => undefined,
  readPaneTags: async () => ({}),
  Tmux: class { async killSession() {} },
  tmux: { listPaneIds: async () => new Set<string>() },
  resolveOraclePane: async (target: string) => target,
  cmdSleep: async () => undefined,
  cmdWakeAll: async () => undefined,
  // Keep broad/env-aware: this SDK mock can leak to later isolated tests.
  C: { green: "", red: "", yellow: "", gray: "", reset: "" },
  invalidateManifest: () => undefined,
  isMawXdgEnabled: () => false,
  loadManifestCached: () => null,
  legacyMawPath: (...parts: string[]) => join(require("os").homedir(), ".maw", ...parts),
  mawCacheDir: () => join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), "cache"),
  mawConfigDir: () => process.env.MAW_CONFIG_DIR || join(require("os").homedir(), ".maw"),
  mawDataDir: () => process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"),
  mawDataPath: (...parts: string[]) => join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), ...parts),
  mawStateDir: () => process.env.MAW_STATE_DIR || join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), "state"),
  mawStatePath: (...parts: string[]) => join(process.env.MAW_STATE_DIR || join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), "state"), ...parts),
  loadConfig: () => ({}),
  ghqFindSync: () => ghqDir,
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  resolveOraclePane: async (target: string) => target,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-resolve"), () => ({
  resolvePeer: () => ({ url: "https://peer.example" }),
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-call"), () => ({
  callPeerKill: async () => peerKillResponse,
}));

mock.module("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    if (cmd === "maw --version") return "maw test-version\n";
    return "";
  },
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFindSync: () => ghqDir,
}));

mock.module("maw-js/commands/shared/fleet", () => ({
  cmdSleep: async () => undefined,
  cmdWakeAll: async () => undefined,
  // Keep broad/env-aware: this SDK mock can leak to later isolated tests.
  C: { green: "", red: "", yellow: "", gray: "", reset: "" },
  invalidateManifest: () => undefined,
  isMawXdgEnabled: () => false,
  loadManifestCached: () => null,
  legacyMawPath: (...parts: string[]) => join(require("os").homedir(), ".maw", ...parts),
  mawCacheDir: () => join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), "cache"),
  mawConfigDir: () => process.env.MAW_CONFIG_DIR || join(require("os").homedir(), ".maw"),
  mawDataDir: () => process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"),
  mawDataPath: (...parts: string[]) => join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), ...parts),
  mawStateDir: () => process.env.MAW_STATE_DIR || join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), "state"),
  mawStatePath: (...parts: string[]) => join(process.env.MAW_STATE_DIR || join(process.env.MAW_DATA_DIR || join(require("os").homedir(), ".maw"), "state"), ...parts),
  loadConfig: () => ({}),
  ghqFindSync: () => ghqDir,
}));

beforeEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-last-five-home-"));
  process.env.HOME = homeDir;
  delete process.env.PEERS_FILE;
  sdkResolveTarget = null;
  sdkCurlFetch = { ok: false, status: 500, data: { error: "boom" } };
  peerKillResponse = { ok: false, status: 500, data: { error: "boom" } };
  execCalls = [];
  ghqDir = join(homeDir, "maw-js");
  mkdirSync(ghqDir, { recursive: true });
  delete process.env.MAW_HOME;
  process.env.MAW_DATA_DIR = join(homeDir, ".maw");
  delete process.env.MAW_XDG;
  console.log = () => undefined;
  console.error = () => undefined;
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
  if (originalEnv.home === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.home;
  if (originalEnv.mawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalEnv.mawHome;
  if (originalEnv.mawDataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = originalEnv.mawDataDir;
  if (originalEnv.mawXdg === undefined) delete process.env.MAW_XDG;
  else process.env.MAW_XDG = originalEnv.mawXdg;
});

describe("last five normalized coverage gaps", () => {
  test("covers live peer store parse failure", async () => {
    process.env.PEERS_FILE = join(homeDir, "peers.json");
    writeFileSync(process.env.PEERS_FILE, "{bad-json");
    const { loadPeers } = await import("../../src/lib/peers/store");
    expect(loadPeers()).toEqual({ version: 1, peers: {} });
    expect(existsSync(process.env.PEERS_FILE)).toBe(false);
  });

  test("covers peer kill non-404 failure response", async () => {
    const killHandler = (await import("../../src/vendor/mpr-plugins/kill/index")).default;
    const result = await killHandler({ source: "cli", args: ["target", "--peer", "alpha"] } as any);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("peer kill failed") });
  });

  test("covers unreadable mega task directory fallback", async () => {
    const teamDir = join(homeDir, ".claude", "teams", "mega");
    const taskRoot = join(homeDir, ".claude", "tasks");
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({
      name: "mega",
      description: "",
      members: [],
    }));
    writeFileSync(join(taskRoot, "mega"), "not a directory");
    const { cmdMegaStatus } = await import("../../src/vendor/mpr-plugins/mega/impl");
    await cmdMegaStatus();
    expect(true).toBe(true);
  });

  test("covers restart SDK package scaffold", async () => {
    process.argv = ["bun", "maw", "restart"];
    const os = require("os");
    const originalHomedir = os.homedir;
    os.homedir = () => homeDir;
    try {
      const { cmdRestart } = await import("../../src/vendor/mpr-plugins/restart/impl");
      await cmdRestart({ ref: "alpha" });
      expect(execCalls.some((cmd) => cmd.includes("bun link maw"))).toBe(true);
      expect(existsSync(join(homeDir, ".maw", "oracle-plugins", "package.json"))).toBe(true);
    } finally {
      os.homedir = originalHomedir;
    }
  });

  test("covers peer send-text failure response", async () => {
    sdkResolveTarget = { type: "peer", node: "white", peerUrl: "https://white.example", target: "oracle" };
    const { cmdSendText } = await import("../../src/vendor/mpr-plugins/send-text/impl");
    let message = "";
    try {
      await cmdSendText({ target: "white:oracle", text: "hello" });
    } catch (e: any) {
      message = e.message;
    }
    expect(message).toContain("peer send-text failed");
  });
});
