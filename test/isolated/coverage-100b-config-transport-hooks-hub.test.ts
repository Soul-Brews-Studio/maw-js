import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";
import type { HubConnection } from "../../src/transports/hub-connection";

const root = join(import.meta.dir, "../..");
const realFsPromises = await import("node:fs/promises");
const realOs = await import("node:os");
const realChildProcess = await import("node:child_process");

let mockHome = "/tmp/maw-coverage-hooks-home";
let readFileImpl: (path: string, encoding?: string) => Promise<string> = async () => "{}";
let readFileCalls: Array<{ path: string; encoding?: string }> = [];
let spawnImpl: (command: string, args: string[], options: any) => { unref: () => void } = () => ({ unref() {} });
let spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
let unrefCalls = 0;
const originalAgentName = process.env.CLAUDE_AGENT_NAME;
const originalMawHome = process.env.MAW_HOME;
const originalMawConfigDir = process.env.MAW_CONFIG_DIR;
const originalMawDataDir = process.env.MAW_DATA_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalWarn = console.warn;
const originalError = console.error;
const globalConfigSandbox = mkdtempSync(join(tmpdir(), "maw-coverage-100b-config-"));
let mockConfigDir = join(globalConfigSandbox, "config");
let mockConfigFile = join(mockConfigDir, "maw.config.json");

mock.module("fs/promises", () => ({
  ...realFsPromises,
  readFile: async (path: string, encoding?: string) => {
    readFileCalls.push({ path, encoding });
    return readFileImpl(path, encoding);
  },
}));

mock.module("os", () => ({
  ...realOs,
  homedir: () => mockHome,
}));

mock.module("child_process", () => ({
  ...realChildProcess,
  spawn: (command: string, args: string[], options: any) => spawnImpl(command, args, options),
}));

let configState: Record<string, any> = { node: "local", federationToken: "test-federation-token-min-16-chars" };
mock.module(join(root, "src/core/paths"), () => ({
  CONFIG_DIR: mockConfigDir,
  CONFIG_FILE: mockConfigFile,
  BASE_DIR: mockConfigDir,
  FLEET_DIR: join(mockConfigDir, "fleet"),
  MAW_ROOT: root,
  resolveHome: () => mockConfigDir,
}));

mock.module(join(root, "src/config"), () => ({
  D: { hmacWindowSeconds: 300 },
  loadConfig: () => configState,
}));
mock.module(join(root, "src/lib/peers/store"), () => ({
  loadPeers: () => ({ peers: {} }),
}));

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function resetHookState() {
  mockHome = "/tmp/maw-coverage-hooks-home";
  readFileImpl = async () => "{}";
  readFileCalls = [];
  spawnCalls = [];
  unrefCalls = 0;
  spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { unref: () => { unrefCalls += 1; } };
  };
  restoreEnv("CLAUDE_AGENT_NAME", originalAgentName);
  delete process.env.MAW_HOME;
  delete process.env.MAW_CONFIG_DIR;
  process.env.MAW_DATA_DIR = join(mockConfigDir, "data");
  process.env.XDG_CONFIG_HOME = join(mockHome, ".config");
}

async function importHooks(label: string) {
  return import(`../../src/core/runtime/hooks.ts?coverage-100b-hooks=${label}-${Date.now()}-${Math.random()}`);
}

function makeConn(id = "workspace"): HubConnection {
  return {
    config: { id, hubUrl: `ws://${id}.example.test`, token: `token-${id}`, sharedAgents: [] },
    ws: null,
    connected: false,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    remoteAgents: new Set(),
  };
}

beforeEach(() => {
  resetHookState();
  configState = { node: "local", federationToken: "test-federation-token-min-16-chars" };
  console.warn = originalWarn;
  console.error = originalError;
});

afterAll(() => {
  rmSync(globalConfigSandbox, { recursive: true, force: true });
  restoreEnv("MAW_HOME", originalMawHome);
  restoreEnv("MAW_CONFIG_DIR", originalMawConfigDir);
  restoreEnv("MAW_DATA_DIR", originalMawDataDir);
  restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome);
});

afterEach(() => {
  resetHookState();
  console.warn = originalWarn;
  console.error = originalError;
});

describe("coverage 100b runtime hooks", () => {
  test("unreadable hook config caches the empty fallback and plain paths are not expanded", async () => {
    readFileImpl = async () => { throw new Error("missing hooks config"); };
    const first = await importHooks("empty-cache");

    await first.runHook("after_send", { to: "pulse", message: "ignored" });
    await first.runHook("after_send", { to: "pulse", message: "ignored again" });

    expect(readFileCalls).toEqual([
      { path: join(mockHome, ".config", "maw", "maw.hooks.json"), encoding: "utf-8" },
      { path: join(mockHome, ".oracle", "maw.hooks.json"), encoding: "utf-8" },
    ]);
    expect(spawnCalls).toEqual([]);

    readFileImpl = async (path) => {
      if (path === join(mockHome, ".config", "maw", "maw.hooks.json")) {
        return JSON.stringify({ hooks: { after_send: "/usr/local/bin/plain-hook" } });
      }
      throw new Error("unexpected legacy hook read");
    };
    delete process.env.CLAUDE_AGENT_NAME;
    const second = await importHooks("plain-path");
    await second.runHook("after_send", { to: "receiver", message: "hello" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(["-c", "/usr/local/bin/plain-hook"]);
    expect(spawnCalls[0].options.env.MAW_FROM).toBe("unknown");
    expect(unrefCalls).toBe(1);
  });

  test("hook config falls back to the legacy oracle path when XDG config is missing", async () => {
    readFileImpl = async (path) => {
      if (path === join(mockHome, ".oracle", "maw.hooks.json")) {
        return JSON.stringify({ hooks: { after_send: "/usr/local/bin/legacy-hook" } });
      }
      throw new Error("missing XDG hook config");
    };

    const hooks = await importHooks("legacy-fallback");
    await hooks.runHook("after_send", { to: "receiver", message: "hello" });

    expect(readFileCalls).toEqual([
      { path: join(mockHome, ".config", "maw", "maw.hooks.json"), encoding: "utf-8" },
      { path: join(mockHome, ".oracle", "maw.hooks.json"), encoding: "utf-8" },
    ]);
    expect(spawnCalls.at(-1)?.args).toEqual(["-c", "/usr/local/bin/legacy-hook"]);
    expect(unrefCalls).toBe(1);
  });
});

describe("coverage 100b hub config and connection", () => {
  test("workspace loader creates a missing directory, accepts valid files, and warns on parse errors", async () => {
    rmSync(mockConfigDir, { recursive: true, force: true });
    const first = await import(`../../src/transports/hub-config.ts?coverage-100b-missing=${Date.now()}-${Math.random()}`);
    try {
      expect(first.loadWorkspaceConfigs()).toEqual([]);

      const workspacesDir = first.WORKSPACES_DIR as string;
      writeFileSync(join(workspacesDir, "good.json"), JSON.stringify({ id: "good", hubUrl: "wss://hub.example.test", token: "tok", sharedAgents: ["neo"] }));
      writeFileSync(join(workspacesDir, "bad.json"), "{not-json");
      writeFileSync(join(workspacesDir, "skip.txt"), "not json");

      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      expect(first.loadWorkspaceConfigs()).toEqual([{ id: "good", hubUrl: "wss://hub.example.test", token: "tok", sharedAgents: ["neo"] }]);
      expect(warnings.join("\n")).toContain("[hub] failed to parse workspace config: bad.json");
    } finally {
      // Keep the mocked CONFIG_FILE root alive for later config/load tests in this file.
    }
  });

  test("hub connection default branch and error message fallback are no-ops/sanitized", async () => {
    const { handleMessage } = await import("../../src/transports/hub-connection.ts");
    const conn = makeConn("default-branch");
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

    handleMessage(conn, JSON.stringify({ type: "unknown-extra" }), new Set(), new Set(), new Set());
    handleMessage(conn, JSON.stringify({ type: "error", message: "bad\nmessage", reason: "ignored" }), new Set(), new Set(), new Set());

    expect(conn.remoteAgents.size).toBe(0);
    expect(errors.join("\n")).toContain("hub error");
    expect(errors.join("\n")).not.toContain("bad\nmessage");
  });
});


describe("coverage 100b config load guards and migrations", () => {
  const originalStderrWrite = process.stderr.write;
  const originalTestMode = process.env.MAW_TEST_MODE;
  const originalQuiet = process.env.MAW_QUIET;

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    restoreEnv("MAW_TEST_MODE", originalTestMode);
    restoreEnv("MAW_QUIET", originalQuiet);
  });

  test("bind-address and host=node warning continuations are covered in-process", async () => {
    rmSync(mockConfigDir, { recursive: true, force: true });
    restoreEnv("MAW_TEST_MODE", "1");
    restoreEnv("MAW_QUIET", "1");
    mkdirSync(mockConfigDir, { recursive: true });
    const stderr: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const load = await import(`../../src/config/load.ts?coverage-100b-config-load=${Date.now()}-${Math.random()}`);

      writeFileSync(mockConfigFile, JSON.stringify({ host: "127.0.0.1", node: "white" }));
      const bindMigrated = load.loadConfig();
      expect(bindMigrated.host).toBe("local");
      expect(bindMigrated.bind).toBe("127.0.0.1");
      expect(stderr.join("")).toContain("Migrated to config.bind; host reset to \"local\".");

      load.resetConfig();
      writeFileSync(mockConfigFile, JSON.stringify({ host: "m5", node: "m5", migrations: {} }));
      const nodeMigrated = load.loadConfig();
      const persisted = JSON.parse((await import("fs")).readFileSync(mockConfigFile, "utf-8"));
      expect(nodeMigrated.host).toBe("local");
      expect(persisted.host).toBe("local");
      expect(stderr.join("")).toContain("host is the SSH target, not the node identity. Resetting host to \"local\".");
    } finally {
      // Shared mocked config root cleaned in afterAll.
    }
  });
});


describe("coverage 100b from-signing body read failure", () => {
  test("fromSigningAuth converts body stream read failures into 401", async () => {
    const { fromSigningAuth, setBunServer } = await import(`../../src/lib/elysia-auth.ts?coverage-100b-body-read=${Date.now()}-${Math.random()}`);
    setBunServer({ requestIP: () => ({ address: "203.0.113.10" }) } as any);
    const app = new Elysia({ prefix: "/api" }).use(fromSigningAuth).post("/send", () => ({ ok: true }));
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("stream boom"));
      },
    });

    const res = await app.handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: {
        "content-type": "application/x-maw-unparsed",
        "x-maw-from": "mawjs:remote",
      },
      body,
    }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "from-signing failed", reason: "body_read_failed" });
    expect(warnings.join("\n")).toContain("body read failed");
  });
});

describe("coverage 100b small transport functions", () => {
  test("LoRa stub records handlers and remains unreachable", async () => {
    const { LoRaTransport } = await import("../../src/transports/lora.ts");
    const lora = new LoRaTransport();
    lora.onMessage(() => undefined);
    lora.onPresence(() => undefined);
    lora.onFeed(() => undefined);
    await lora.connect();
    expect(lora.connected).toBe(false);
    expect(await lora.send({ oracle: "neo" }, "hello")).toBe(false);
    await lora.publishPresence({ oracle: "neo", host: "white", status: "ready", timestamp: 1 });
    await lora.publishFeed({ type: "note", source: "test", message: "hello", timestamp: 1 } as any);
    expect(lora.canReach({ oracle: "neo" })).toBe(false);
    await lora.disconnect();
    expect(lora.connected).toBe(false);
  });
});
