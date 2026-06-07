import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Workspace } from "../../src/api/workspace-types";
import type { OracleEntry, RegistryCache } from "../../src/core/fleet/registry-oracle-types";
import type { MawConfig } from "../../src/config";
import { mockConfigModule } from "../helpers/mock-config";

let configStore: Partial<MawConfig> = {};
const configMock = () => mockConfigModule(() => configStore);
mock.module(join(import.meta.dir, "../../src/config"), configMock);
mock.module(import.meta.resolve("../../src/config.ts"), configMock);

let ghqRoot = "/tmp/maw-ghq";
let localEntries: OracleEntry[] = [];
let remoteEntries: OracleEntry[] = [];
let scanLocalCalls: boolean[] = [];
let scanRemoteCalls: Array<{ orgs?: string[]; verbose: boolean }> = [];
let writtenCaches: RegistryCache[] = [];

const ghqRootMock = () => ({ getGhqRoot: () => ghqRoot });
mock.module(join(import.meta.dir, "../../src/config/ghq-root"), ghqRootMock);
mock.module(import.meta.resolve("../../src/config/ghq-root.ts"), ghqRootMock);

const cacheMock = () => ({
  writeCache: (cache: RegistryCache) => {
    writtenCaches.push(JSON.parse(JSON.stringify(cache)) as RegistryCache);
  },
});
mock.module(join(import.meta.dir, "../../src/core/fleet/registry-oracle-cache"), cacheMock);
mock.module(import.meta.resolve("../../src/core/fleet/registry-oracle-cache.ts"), cacheMock);

const scanLocalMock = () => ({
  scanLocal: (verbose = true) => {
    scanLocalCalls.push(verbose);
    return localEntries;
  },
});
mock.module(join(import.meta.dir, "../../src/core/fleet/registry-oracle-scan-local"), scanLocalMock);
mock.module(import.meta.resolve("../../src/core/fleet/registry-oracle-scan-local.ts"), scanLocalMock);

const scanRemoteMock = () => ({
  scanRemote: async (orgs?: string[], verbose = true) => {
    scanRemoteCalls.push({ orgs, verbose });
    return remoteEntries;
  },
});
mock.module(join(import.meta.dir, "../../src/core/fleet/registry-oracle-scan-remote"), scanRemoteMock);
mock.module(import.meta.resolve("../../src/core/fleet/registry-oracle-scan-remote.ts"), scanRemoteMock);

const { workspaces } = await import("../../src/api/workspace-storage");
const { authenticateWorkspace, wsSign, wsVerify } = await import("../../src/api/workspace-auth");
const { runBootstrap } = await import("../../src/cli/plugin-bootstrap");
const { scanAndCache, scanFull } = await import("../../src/core/fleet/registry-oracle-orchestrate");

const realDateNow = Date.now;
const realSpawn = Bun.spawn;
const realConsole = {
  log: console.log,
  warn: console.warn,
  stderrWrite: process.stderr.write,
};

type SpawnProc = ReturnType<typeof Bun.spawn>;
type SpawnHandler = (cmd: string[], opts?: { stdout?: string; stderr?: string }) => SpawnProc;

let spawnHandler: SpawnHandler = () => {
  throw new Error("unexpected Bun.spawn");
};

function textStream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function spawnProc(stdout = "", code = 0): SpawnProc {
  return {
    stdout: textStream(stdout),
    stderr: textStream(""),
    exited: Promise.resolve(code),
  } as unknown as SpawnProc;
}

(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], opts?: { stdout?: string; stderr?: string }) =>
  spawnHandler(cmd, opts)) as typeof Bun.spawn;

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "alpha",
    token: "workspace-token",
    joinCode: "JOIN-123",
    joinCodeExpiresAt: Date.now() + 60_000,
    createdAt: "2026-05-18T00:00:00.000Z",
    creatorNodeId: "m5",
    nodes: [],
    agents: [],
    feed: [],
    ...overrides,
  };
}

function oracleEntry(overrides: Partial<OracleEntry>): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: "mawjs-oracle",
    name: "mawjs",
    local_path: "",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...overrides,
  };
}

async function captureConsole<T>(fn: () => T | Promise<T>) {
  const logs: string[] = [];
  const warns: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = String(chunk).trimEnd();
    if (text.startsWith("⚠ ")) warns.push(text.slice(2));
    else if (text) logs.push(text);
    return realConsole.stderrWrite.call(process.stderr, chunk as string, ...(args as []));
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, logs, warns };
  } finally {
    console.log = realConsole.log;
    console.warn = realConsole.warn;
    process.stderr.write = realConsole.stderrWrite;
  }
}

beforeEach(() => {
  configStore = {};
  ghqRoot = "/tmp/maw-ghq";
  localEntries = [];
  remoteEntries = [];
  scanLocalCalls = [];
  scanRemoteCalls = [];
  writtenCaches = [];
  workspaces.clear();
  Date.now = () => 1_779_052_800_000; // 2026-05-18T00:00:00Z
  spawnHandler = () => {
    throw new Error("unexpected Bun.spawn");
  };
});

afterEach(() => {
  configStore = {};
  workspaces.clear();
  Date.now = realDateNow;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  process.stderr.write = realConsole.stderrWrite;
});

afterAll(() => {
  Date.now = realDateNow;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = realSpawn;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  process.stderr.write = realConsole.stderrWrite;
});

describe("workspace-auth isolated branch coverage", () => {
  test("wsVerify accepts the exact HMAC and rejects stale, short, bad, and malformed signatures", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = wsSign("workspace-token", "POST", "/workspace/ws-1/agents", timestamp);

    expect(wsVerify("workspace-token", "POST", "/workspace/ws-1/agents", timestamp, signature)).toBe(true);
    expect(wsVerify("workspace-token", "POST", "/workspace/ws-1/agents", timestamp - 301, signature)).toBe(false);
    expect(wsVerify("workspace-token", "POST", "/workspace/ws-1/agents", timestamp, "short")).toBe(false);
    expect(wsVerify("workspace-token", "POST", "/workspace/ws-1/agents", timestamp, "0".repeat(signature.length))).toBe(false);
    expect(wsVerify("workspace-token", "POST", "/workspace/ws-1/agents", timestamp, "z".repeat(signature.length))).toBe(false);
  });

  test("authenticateWorkspace returns null for every guard and the workspace for valid headers", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = wsSign("workspace-token", "GET", "/workspace/ws-1/feed", timestamp);

    expect(authenticateWorkspace("missing", "GET", "/workspace/ws-1/feed", { sig: signature, ts: String(timestamp) })).toBeNull();

    const ws = makeWorkspace();
    workspaces.set(ws.id, ws);

    expect(authenticateWorkspace(ws.id, "GET", "/workspace/ws-1/feed", { ts: String(timestamp) })).toBeNull();
    expect(authenticateWorkspace(ws.id, "GET", "/workspace/ws-1/feed", { sig: signature })).toBeNull();
    expect(authenticateWorkspace(ws.id, "GET", "/workspace/ws-1/feed", { sig: signature, ts: "not-a-number" })).toBeNull();
    expect(authenticateWorkspace(ws.id, "GET", "/workspace/ws-1/feed", { sig: "0".repeat(signature.length), ts: String(timestamp) })).toBeNull();
    expect(authenticateWorkspace(ws.id, "GET", "/workspace/ws-1/feed", { sig: signature, ts: String(timestamp) })).toBe(ws);
  });
});

describe("plugin-bootstrap pluginSources coverage", () => {
  let workDir: string;
  let srcDir: string;
  let pluginDir: string;
  let bundledDir: string;
  let ghqRootDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "maw-bootstrap-extra-"));
    srcDir = join(workDir, "src");
    pluginDir = join(workDir, "plugins");
    bundledDir = join(srcDir, "commands", "plugins");
    ghqRootDir = join(workDir, "ghq");
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(ghqRootDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeBundledPlugin(name: string) {
    const dir = join(bundledDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
    return dir;
  }

  test("invalid pluginSource schemes are warned and skipped before any ghq spawn", async () => {
    configStore = { pluginSources: ["file:///tmp/not-allowed"] };
    const spawnCalls: string[][] = [];
    spawnHandler = (cmd) => {
      spawnCalls.push(cmd);
      return spawnProc();
    };

    const { logs, warns } = await captureConsole(() => runBootstrap(pluginDir, srcDir));

    expect(spawnCalls).toEqual([]);
    expect(warns).toEqual(["[maw] skipping pluginSource with invalid scheme: file:///tmp/not-allowed"]);
    expect(logs).toEqual([`[maw] bootstrapped 0 plugins → ${pluginDir}`]);
  });

  test("pluginSources copy package plugins and root plugin manifests without overwriting bundled links", async () => {
    const bundledSkipMe = makeBundledPlugin("skip-me");
    const packageRepo = join(ghqRootDir, "github.com", "acme", "plugin-pack");
    const packageOne = join(packageRepo, "packages", "pkg-one");
    const packageSkip = join(packageRepo, "packages", "skip-me");
    const packageIgnored = join(packageRepo, "packages", "no-manifest");
    mkdirSync(packageOne, { recursive: true });
    mkdirSync(packageSkip, { recursive: true });
    mkdirSync(packageIgnored, { recursive: true });
    writeFileSync(join(packageOne, "plugin.json"), JSON.stringify({ name: "pkg-one" }));
    writeFileSync(join(packageOne, "index.ts"), "export default {}\n");
    writeFileSync(join(packageSkip, "plugin.json"), JSON.stringify({ name: "skip-me" }));
    writeFileSync(join(packageSkip, "index.ts"), "export default { stale: true }\n");
    writeFileSync(join(packageIgnored, "index.ts"), "export default {}\n");

    const rootRepo = join(ghqRootDir, "github.com", "acme", "solo-plugin");
    mkdirSync(rootRepo, { recursive: true });
    writeFileSync(join(rootRepo, "plugin.json"), JSON.stringify({ name: "solo-installed" }));
    writeFileSync(join(rootRepo, "index.ts"), "export default {}\n");

    configStore = {
      pluginSources: [
        "https://github.com/acme/plugin-pack.git",
        "https://github.com/acme/solo-plugin.git",
      ],
    };

    const spawnCalls: string[][] = [];
    spawnHandler = (cmd) => {
      spawnCalls.push([...cmd]);
      if (cmd[0] === "ghq" && cmd[1] === "root") return spawnProc(`${ghqRootDir}\n`);
      return spawnProc();
    };

    await captureConsole(() => runBootstrap(pluginDir, srcDir));

    expect(spawnCalls).toEqual([
      ["ghq", "get", "-u", "https://github.com/acme/plugin-pack.git"],
      ["ghq", "root"],
      ["ghq", "get", "-u", "https://github.com/acme/solo-plugin.git"],
      ["ghq", "root"],
    ]);
    expect(readdirSync(pluginDir).sort()).toEqual(["pkg-one", "skip-me", "solo-installed"]);
    expect(lstatSync(join(pluginDir, "skip-me")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, "skip-me"))).toBe(bundledSkipMe);
    expect(readFileSync(join(pluginDir, "pkg-one", "index.ts"), "utf-8")).toContain("export default");
    expect(readFileSync(join(pluginDir, "solo-installed", "plugin.json"), "utf-8")).toContain("solo-installed");
    expect(existsSync(join(pluginDir, "no-manifest"))).toBe(false);
  });

  test("pluginSource failures are swallowed so bootstrap can still finish", async () => {
    configStore = { pluginSources: ["https://github.com/acme/fails.git"] };
    spawnHandler = () => {
      throw new Error("ghq unavailable");
    };

    const { logs } = await captureConsole(() => runBootstrap(pluginDir, srcDir));

    expect(readdirSync(pluginDir)).toEqual([]);
    expect(logs).toEqual([`[maw] bootstrapped 0 plugins → ${pluginDir}`]);
  });
});

describe("registry-oracle-orchestrate isolated coverage", () => {
  test("scanAndCache remote mode writes an empty local cache without scanning local repos", () => {
    ghqRoot = "/tmp/ghq-remote-mode";

    const cache = scanAndCache("remote", false);

    expect(scanLocalCalls).toEqual([]);
    expect(cache).toMatchObject({ schema: 1, ghq_root: "/tmp/ghq-remote-mode", oracles: [] });
    expect(writtenCaches).toEqual([cache]);
  });

  test("scanFull merges remote gaps, enriches local psi, sorts, logs when verbose, and writes cache", async () => {
    ghqRoot = "/tmp/ghq-full";
    const localDup = oracleEntry({ org: "zed", repo: "shared-oracle", name: "shared", has_psi: false, local_path: "/local/shared" });
    localEntries = [
      localDup,
      oracleEntry({ org: "zed", repo: "zulu-oracle", name: "zulu", has_psi: true, local_path: "/local/zulu" }),
    ];
    remoteEntries = [
      oracleEntry({ org: "alpha", repo: "alpha-oracle", name: "alpha", has_psi: true }),
      oracleEntry({ org: "zed", repo: "shared-oracle", name: "shared", has_psi: true }),
      oracleEntry({ org: "zed", repo: "aardvark-oracle", name: "aardvark", has_psi: false }),
    ];

    const { result: cache, logs } = await captureConsole(() => scanFull(["alpha", "zed"], true));

    expect(scanLocalCalls).toEqual([true]);
    expect(scanRemoteCalls).toEqual([{ orgs: ["alpha", "zed"], verbose: true }]);
    expect(localDup.has_psi).toBe(true);
    expect(cache.ghq_root).toBe("/tmp/ghq-full");
    expect(cache.oracles.map((entry) => `${entry.org}/${entry.name}:${entry.has_psi}`)).toEqual([
      "alpha/alpha:true",
      "zed/aardvark:false",
      "zed/shared:true",
      "zed/zulu:true",
    ]);
    expect(writtenCaches).toEqual([cache]);
    expect(logs[0]).toContain("scanning local");
    expect(logs[1]).toContain("2 local oracles found");
  });
});
