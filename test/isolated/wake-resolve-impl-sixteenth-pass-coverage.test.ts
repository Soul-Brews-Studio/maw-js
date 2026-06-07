/**
 * Sixteenth-pass isolated function coverage for wake-resolve-impl.
 *
 * Mock-only: keeps the wake resolver hermetic while exercising the picker,
 * worktree, fleet, peer, session, and tmux-env callbacks in one Bun process so
 * LCOV's per-process function totals can move upward.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const fleetRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-16-fleet-"));
const tempRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-16-temp-"));

type OracleResult =
  | { kind: "not-found" }
  | { kind: "exact"; oracle: { owner: string; repo: string; path?: string } }
  | { kind: "ambiguous"; candidates: Array<{ owner: string; repo: string; path?: string }> };

let config: any;
let envVars: Record<string, string>;
let sessions: Array<{ name: string }>;
let ghqListValue: string[];
let ghqListThrows: boolean;
let ghqFindMap: Record<string, string | null>;
let ghqFindImpl: ((query: string) => Promise<string | null>) | null;
let resolveResults: OracleResult[];
let pickedOracle: { owner: string; repo: string; path?: string } | null;
let scanWorktreesResult: Array<{ path: string; mainRepo: string }>;
let scanWorktreesThrows: boolean;
let scanSuggestResult: any;
let scanSuggestThrows: boolean;
let scanSuggestArgs: any[];
let hostExecCalls: string[];
let hostExecHandler: (cmd: string) => Promise<string>;
let curlFetchCalls: Array<{ url: string; init: any }>;
let curlFetchHandler: (url: string, init?: any) => Promise<any>;
let setEnvCalls: Array<{ session: string; key: string; val: string }>;
let isattyThrows: boolean;
let isattyValue: boolean;
let logs: string[];
let errors: string[];
let exitCodes: number[];
let spawnSpy: ReturnType<typeof spyOn> | null;

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

function resetFleetDir(): void {
  rmSync(fleetRoot, { recursive: true, force: true });
  mkdirSync(fleetRoot, { recursive: true });
}

function writeFleet(name: string, body: unknown): void {
  writeFileSync(join(fleetRoot, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

function resetResolverState(): void {
  config = { githubOrg: "FallbackOrg", githubOrgs: undefined, peers: [], sessions: {} };
  envVars = {};
  sessions = [];
  ghqListValue = [];
  ghqListThrows = false;
  ghqFindMap = {};
  ghqFindImpl = null;
  resolveResults = [{ kind: "not-found" }];
  pickedOracle = null;
  scanWorktreesResult = [];
  scanWorktreesThrows = false;
  scanSuggestResult = null;
  scanSuggestThrows = false;
  scanSuggestArgs = [];
  hostExecCalls = [];
  hostExecHandler = async () => "";
  curlFetchCalls = [];
  curlFetchHandler = async () => ({ ok: false });
  setEnvCalls = [];
  isattyThrows = false;
  isattyValue = false;
  logs = [];
  errors = [];
  exitCodes = [];
}

mock.module("node:tty", () => ({
  isatty: () => {
    if (isattyThrows) throw new Error("tty probe unavailable");
    return isattyValue;
  },
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  FLEET_DIR: fleetRoot,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecHandler(cmd);
  },
  curlFetch: async (url: string, init?: any) => {
    curlFetchCalls.push({ url, init });
    return curlFetchHandler(url, init);
  },
  tmux: {
    listSessions: async () => sessions,
    setEnvironment: async (session: string, key: string, val: string) => {
      setEnvCalls.push({ session, key, val });
    },
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
  getEnvVars: () => envVars,
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => {
    if (ghqListThrows) throw new Error("ghq list unavailable");
    return ghqListValue;
  },
  ghqFind: async (query: string) => ghqFindImpl ? ghqFindImpl(query) : (ghqFindMap[query] ?? null),
}));

mock.module(join(srcRoot, "src/core/resolve"), () => ({
  resolveOracle: async () => resolveResults.shift() ?? { kind: "not-found" },
  pickOracle: async () => pickedOracle,
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => {
    if (scanWorktreesThrows) throw new Error("scan unavailable");
    return scanWorktreesResult;
  },
}));

mock.module(join(srcRoot, "src/commands/shared/wake-resolve-scan-suggest"), () => ({
  scanSuggestOracle: async (...args: any[]) => {
    scanSuggestArgs.push(args);
    if (scanSuggestThrows) throw new Error("scan suggest unavailable");
    return scanSuggestResult;
  },
}));

const {
  detectSession,
  findReusableWorktreeBySlug,
  findWorktrees,
  getSessionMap,
  resolveFleetSession,
  resolveFromWorktrees,
  resolveLocalOracleRepoName,
  resolveOracle,
  sanitizeBranchName,
  setSessionEnv,
} = await import("../../src/commands/shared/wake-resolve-impl");

beforeEach(() => {
  resetFleetDir();
  resetResolverState();
  spawnSpy = null;

  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
});

afterEach(() => {
  spawnSpy?.mockRestore();
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTTY });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalStdoutIsTTY });
});

afterAll(() => {
  rmSync(fleetRoot, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("wake-resolve-impl helper callbacks in one process", () => {
  test("covers local, reusable, and shell-discovered worktree helper branches", async () => {
    const mainRepo = join(tempRoot, "Org", "wireboy-oracle");
    mkdirSync(mainRepo, { recursive: true });
    const worktrees = [{ path: "/wt/wireboy", mainRepo: "github.com/Org/wireboy-oracle" }];

    await expect(resolveFromWorktrees("wireboy", async () => worktrees as any, async () => `${mainRepo}/.git\n`, () => true)).resolves.toEqual({
      repoPath: mainRepo,
      repoName: "wireboy-oracle",
      parentDir: join(tempRoot, "Org"),
    });
    await expect(resolveFromWorktrees("wireboy", async () => worktrees as any, async () => `${mainRepo}\n`, () => true)).resolves.toEqual({
      repoPath: mainRepo,
      repoName: "wireboy-oracle",
      parentDir: join(tempRoot, "Org"),
    });
    await expect(resolveFromWorktrees("wireboy", async () => worktrees as any, async () => "\n", () => true)).resolves.toBeNull();
    await expect(resolveFromWorktrees("wireboy", async () => worktrees as any, async () => mainRepo, () => false)).resolves.toBeNull();
    await expect(resolveFromWorktrees("ghost", async () => worktrees as any, async () => { throw new Error("not called"); }, () => true)).resolves.toBeNull();

    const repos = [
      "github.com/Soul-Brews-Studio/mawjs-codex-oracle",
      "github.com/Soul-Brews-Studio/mawjs-oracle",
      "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
      "github.com/Alt/pulse-oracle",
      "github.com/Other/pulse-oracle",
      "github.com/Org/42-bot-oracle",
      "not-an-oracle",
    ];
    expect(resolveLocalOracleRepoName("48-mawjs-codex", repos)).toEqual({ kind: "exact", match: "mawjs-codex-oracle" });
    expect(resolveLocalOracleRepoName("42-bot", repos)).toEqual({ kind: "exact", match: "42-bot-oracle" });
    expect(resolveLocalOracleRepoName("v3", repos)).toEqual({ kind: "fuzzy", match: "arra-oracle-v3-oracle" });
    expect(resolveLocalOracleRepoName("pulse", repos)).toEqual({ kind: "ambiguous", candidates: ["Alt/pulse-oracle", "Other/pulse-oracle"] });
    expect(resolveLocalOracleRepoName("", repos)).toEqual({ kind: "none" });
    expect(resolveLocalOracleRepoName("ghost", repos)).toEqual({ kind: "none" });

    hostExecHandler = async (cmd) => cmd.startsWith("ls -d")
      ? "/repos/Org/neo-oracle.wt-1-blue\n/repos/Org/neo-oracle.wt-2-green\n"
      : "";
    await expect(findWorktrees("/repos/Org", "neo-oracle")).resolves.toEqual([
      { path: "/repos/Org/neo-oracle.wt-1-blue", name: "1-blue" },
      { path: "/repos/Org/neo-oracle.wt-2-green", name: "2-green" },
    ]);

    hostExecCalls = [];
    hostExecHandler = async (cmd) => {
      if (cmd.startsWith("ls -d")) return "\n";
      if (cmd.includes("/neo-oracle/agents")) return "\n";
      return "/repos/o'rg/neo-oracle.wt-7-fix-login\n";
    };
    await expect(findWorktrees("/repos/o'rg", "neo-oracle", "fix-login", "neo-oracle")).resolves.toEqual([
      { path: "/repos/o'rg/neo-oracle.wt-7-fix-login", name: "7-fix-login" },
    ]);
    expect(hostExecCalls).toContain("find '/repos/o'\\''rg/neo-oracle/agents' -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true");
    expect(hostExecCalls).toContain("find '/repos/o'\\''rg' -maxdepth 1 -type d -name 'neo-oracle.wt-*-fix-login' 2>/dev/null || true");

    const parentDir = join(tempRoot, "reuse-scope");
    rmSync(parentDir, { recursive: true, force: true });
    mkdirSync(parentDir, { recursive: true });
    expect(findReusableWorktreeBySlug(parentDir, "blue", "neo-oracle", {
      readdirSync: () => ["other-oracle.wt-1-blue", "neo-oracle.wt-2-blue", "neo-oracle.wt-3-red"] as any,
      statSync: (() => ({ isDirectory: () => true })) as any,
    })).toEqual({ path: join(parentDir, "neo-oracle.wt-2-blue"), name: "2-blue" });
    expect(findReusableWorktreeBySlug(parentDir, "blue", undefined, {
      readdirSync: () => ["z-oracle.wt-9-blue", "a-oracle.wt-1-blue"] as any,
      statSync: ((path: string) => {
        if (path.includes("z-oracle")) throw new Error("stat race");
        return { isDirectory: () => true } as any;
      }) as any,
    })).toEqual({ path: join(parentDir, "a-oracle.wt-1-blue"), name: "1-blue" });
    expect(findReusableWorktreeBySlug(parentDir, "blue", undefined, {
      readdirSync: (() => { throw new Error("permission denied"); }) as any,
    })).toBeNull();
    expect(findReusableWorktreeBySlug(parentDir, "missing", "neo-oracle", {
      readdirSync: () => ["neo-oracle.wt-1-blue"] as any,
      statSync: (() => ({ isDirectory: () => true })) as any,
    })).toBeNull();

    config.sessions = { neo: "22-neo" };
    expect(getSessionMap()).toEqual({ neo: "22-neo" });
    expect(sanitizeBranchName("  Feature: Pulse Board!!...  ")).toBe("feature-pulse-board");
    expect(sanitizeBranchName("--")).toBe("");
    expect(sanitizeBranchName("x".repeat(80))).toHaveLength(50);
  });

  test("covers local ambiguity picker selected, aborted, and noninteractive branches", async () => {
    ghqListValue = ["github.com/Org/pulse-oracle", "github.com/Alt/pulse-oracle"];
    resolveResults = [{
      kind: "ambiguous",
      candidates: [
        { owner: "Org", repo: "pulse-oracle", path: "/repos/Org/pulse-oracle" },
        { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" },
      ],
    }];
    pickedOracle = { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" };

    const ttyModule = require("node:tty") as typeof import("node:tty");
    const originalIsatty = ttyModule.isatty;
    ttyModule.isatty = (() => true) as typeof ttyModule.isatty;
    try {
      await expect(resolveOracle("pulse")).resolves.toEqual({
        repoPath: "/repos/Alt/pulse-oracle",
        repoName: "pulse-oracle",
        parentDir: "/repos/Alt",
      });
    } finally {
      ttyModule.isatty = originalIsatty;
    }
    expect(errors.join("\n")).toContain("Org/pulse-oracle");

    resetResolverState();
    ghqListValue = ["github.com/Org/pulse-oracle", "github.com/Alt/pulse-oracle"];
    resolveResults = [{
      kind: "ambiguous",
      candidates: [
        { owner: "Org", repo: "pulse-oracle", path: "/repos/Org/pulse-oracle" },
        { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" },
      ],
    }];
    pickedOracle = null;
    scanSuggestResult = { repoPath: "/suggested/pulse-oracle", repoName: "pulse-oracle", parentDir: "/suggested" };
    ttyModule.isatty = (() => true) as typeof ttyModule.isatty;
    try {
      await expect(resolveOracle("pulse", { allLocal: true })).resolves.toEqual(scanSuggestResult);
    } finally {
      ttyModule.isatty = originalIsatty;
    }
    expect(errors.join("\n")).toContain("aborted");
    expect(exitCodes).toContain(1);
    expect(scanSuggestArgs[0]).toEqual(["pulse", { allLocal: true }]);

    resetResolverState();
    ghqListValue = ["github.com/Org/pulse-oracle", "github.com/Alt/pulse-oracle"];
    resolveResults = [{
      kind: "ambiguous",
      candidates: [
        { owner: "Org", repo: "pulse-oracle", path: "/repos/Org/pulse-oracle" },
        { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" },
      ],
    }];
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    scanSuggestResult = { repoPath: "/suggested/pulse-oracle", repoName: "pulse-oracle", parentDir: "/suggested" };
    ttyModule.isatty = (() => { throw new Error("tty probe unavailable"); }) as typeof ttyModule.isatty;
    try {
      await expect(resolveOracle("pulse")).resolves.toEqual(scanSuggestResult);
    } finally {
      ttyModule.isatty = originalIsatty;
    }
    expect(errors.join("\n")).toContain("use the full name: maw wake <org>/<repo>");
    expect(exitCodes).toContain(1);
  });

  test("covers resolveOracle fleet, worktree, configured-org, peer, and scan-suggest exits", async () => {
    ghqListValue = ["github.com/Alt/direct-oracle"];
    resolveResults = [{ kind: "exact", oracle: { owner: "Alt", repo: "direct-oracle", path: "/repos/Alt/direct-oracle" } }];
    await expect(resolveOracle("direct")).resolves.toEqual({
      repoPath: "/repos/Alt/direct-oracle",
      repoName: "direct-oracle",
      parentDir: "/repos/Alt",
    });

    resetResolverState();
    ghqListValue = ["github.com/Alt/pathless-oracle"];
    resolveResults = [{ kind: "exact", oracle: { owner: "Alt", repo: "pathless-oracle" } }];
    scanSuggestResult = { repoPath: "/suggested/pathless-oracle", repoName: "pathless-oracle", parentDir: "/suggested" };
    await expect(resolveOracle("pathless")).resolves.toEqual(scanSuggestResult);

    resetResolverState();
    ghqListValue = ["github.com/Soul-Brews-Studio/arra-oracle-v3-oracle"];
    resolveResults = [
      { kind: "not-found" },
      { kind: "exact", oracle: { owner: "Soul-Brews-Studio", repo: "arra-oracle-v3-oracle", path: "/repos/arra-oracle-v3-oracle" } },
    ];
    await expect(resolveOracle("v3")).resolves.toEqual({
      repoPath: "/repos/arra-oracle-v3-oracle",
      repoName: "arra-oracle-v3-oracle",
      parentDir: "/repos",
    });
    expect(logs.some((line) => line.includes("fuzzy match: arra-oracle-v3-oracle"))).toBe(true);

    resetResolverState();
    ghqListThrows = true;
    scanSuggestResult = { repoPath: "/suggested/nolocal-oracle", repoName: "nolocal-oracle", parentDir: "/suggested" };
    await expect(resolveOracle("nolocal")).resolves.toEqual(scanSuggestResult);

    resetResolverState();
    writeFleet("22-neo", { windows: [{ name: "neo-oracle", repo: "Org/neo-oracle" }] });
    ghqFindMap["/neo-oracle"] = "/repos/Org/neo-oracle";
    await expect(resolveOracle("neo")).resolves.toEqual({
      repoPath: "/repos/Org/neo-oracle",
      repoName: "neo-oracle",
      parentDir: "/repos/Org",
    });

    resetFleetDir();
    resetResolverState();
    writeFleet("23-pin", { windows: [{ name: "pin-oracle", repo: "Org/pin-oracle" }] });
    let findCount = 0;
    ghqFindImpl = async () => (++findCount === 1 ? null : "/repos/Org/pin-oracle");
    await expect(resolveOracle("pin")).resolves.toEqual({
      repoPath: "/repos/Org/pin-oracle",
      repoName: "pin-oracle",
      parentDir: "/repos/Org",
    });

    resetFleetDir();
    resetResolverState();
    writeFleet("24-clone", { windows: [{ name: "clone-oracle", repo: "Org/clone-oracle" }] });
    hostExecHandler = async (cmd) => {
      if (cmd.includes("github.com/Org/clone-oracle")) ghqFindMap["/clone-oracle"] = "/repos/Org/clone-oracle";
      return "";
    };
    await expect(resolveOracle("clone")).resolves.toEqual({
      repoPath: "/repos/Org/clone-oracle",
      repoName: "clone-oracle",
      parentDir: "/repos/Org",
    });

    resetFleetDir();
    resetResolverState();
    writeFleet("25-broken", { windows: [{ name: "broken-oracle", repo: "Org/broken-oracle" }] });
    hostExecHandler = async () => { throw new Error("network down\nmore"); };
    await expect(resolveOracle("broken")).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("fleet-pinned Org/broken-oracle clone/update failed: network down");
    expect(exitCodes).toContain(1);

    resetFleetDir();
    resetResolverState();
    const workMain = join(tempRoot, "Work", "work-oracle");
    mkdirSync(workMain, { recursive: true });
    scanWorktreesResult = [{ path: "/tmp/work-oracle-linked", mainRepo: "github.com/Work/work-oracle" }];
    hostExecHandler = async () => `${workMain}/.git\n`;
    await expect(resolveOracle("work")).resolves.toEqual({
      repoPath: workMain,
      repoName: "work-oracle",
      parentDir: join(tempRoot, "Work"),
    });

    resetResolverState();
    scanWorktreesThrows = true;
    config.githubOrgs = ["Missing", "Found"];
    hostExecHandler = async (cmd) => {
      if (cmd.includes("Missing/neo-oracle")) throw new Error("missing");
      if (cmd.includes("Found/neo-oracle")) return "{}";
      return "";
    };
    ghqFindImpl = async (query) => query === "/neo-oracle" ? "/repos/Found/neo-oracle" : null;
    await expect(resolveOracle("neo")).resolves.toEqual({
      repoPath: "/repos/Found/neo-oracle",
      repoName: "neo-oracle",
      parentDir: "/repos/Found",
    });

    resetResolverState();
    config.githubOrgs = ["Found"];
    hostExecHandler = async (cmd) => {
      if (cmd.includes("ghq get")) throw new Error("clone refused\nextra");
      if (cmd.includes("Found/flaky-oracle")) return "{}";
      throw new Error("missing");
    };
    scanSuggestResult = { repoPath: "/suggested/flaky-oracle", repoName: "flaky-oracle", parentDir: "/suggested" };
    await expect(resolveOracle("flaky")).resolves.toEqual(scanSuggestResult);
    expect(errors.join("\n")).toContain("clone failed for Found/flaky-oracle: clone refused");

    resetResolverState();
    config.peers = ["http://bad-peer", "http://peer"];
    curlFetchHandler = async (url, init) => {
      if (url.startsWith("http://bad-peer")) throw new Error("offline");
      if (url.endsWith("/api/sessions")) return { ok: true, data: { sessions: [{ name: "88-neo", windows: [{ index: 3, name: "helper" }] }] } };
      if (url.endsWith("/api/send")) return { ok: true, data: { init } };
      return { ok: false };
    };
    await resolveOracle("neo");
    expect(curlFetchCalls.at(-1)?.url).toBe("http://peer/api/send");
    expect(JSON.parse(curlFetchCalls.at(-1)!.init.body)).toEqual({ target: "88-neo:3", text: "" });
    expect(exitCodes).toContain(0);

    resetResolverState();
    config.peers = ["http://none"];
    curlFetchHandler = async () => ({ ok: false });
    scanSuggestThrows = true;
    await expect(resolveOracle("missing")).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("oracle repo not found: missing");
    expect(exitCodes).toContain(1);
  });

  test("covers resolveFleetSession and detectSession URL, numeric, prefix, and generic paths", async () => {
    writeFleet("23-discord-admin", { name: "23-discord-admin", windows: [{ name: "discord-oracle", repo: "Org/discord-oracle" }] });
    sessions = [{ name: "23-discord-admin" }];
    expect(resolveFleetSession("discord")).toBe("23-discord-admin");
    await expect(detectSession("discord", "discord-oracle")).resolves.toBe("23-discord-admin");

    config.sessions = { neo: "mapped-neo" };
    sessions = [{ name: "mapped-neo" }];
    await expect(detectSession("neo")).resolves.toBe("mapped-neo");

    resetFleetDir();
    config.sessions = {};
    sessions = [{ name: "77-wireboy-oracle" }];
    await expect(detectSession("wireboy", "wireboy-oracle")).resolves.toBe("77-wireboy-oracle");

    sessions = [{ name: "11-pulse-oracle" }, { name: "12-pulse-oracle" }];
    await expect(detectSession("pulse", "pulse-oracle")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("pulse-oracle");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "24-discord-oracle" }, { name: "25-discord-oracle" }];
    await expect(detectSession("discord")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("fleet oracle sessions");
    expect(exitCodes).toContain(1);

    errors = [];
    exitCodes = [];
    sessions = [{ name: "24-discord-oracle" }];
    await expect(detectSession("discord")).resolves.toBe("24-discord-oracle");

    sessions = [{ name: "47-mawjs" }];
    await expect(detectSession("mawjs")).resolves.toBe("47-mawjs");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "47-mawjs" }, { name: "48-mawjs" }];
    await expect(detectSession("mawjs")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("matches 2 fleet sessions");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "20-homekeeper" }];
    await expect(detectSession("homeke")).resolves.toBe("20-homekeeper");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "20-homekeeper" }, { name: "21-homekey" }];
    await expect(detectSession("homeke")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("homeke");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "neo-alpha" }, { name: "neo-beta" }];
    await expect(detectSession("neo")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("matches 2 sessions");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "neo-view" }, { name: "maw-pty-neo" }];
    await expect(detectSession("neo")).resolves.toBeNull();
    expect(errors.join("\n")).not.toContain("ambiguous");
  });

  test("covers setSessionEnv plain, successful pass secret, and failing pass secret paths", async () => {
    envVars = { FOO: "bar", EMPTY: "" };
    await setSessionEnv("session-a");
    expect(setEnvCalls).toEqual([
      { session: "session-a", key: "FOO", val: "bar" },
      { session: "session-a", key: "EMPTY", val: "" },
    ]);

    const successfulProc = {
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("secret\n")); controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(0),
    };
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(successfulProc as any);
    envVars = { SECRET: "pass:good" };
    setEnvCalls = [];
    await setSessionEnv("session-a");
    expect(setEnvCalls).toEqual([{ session: "session-a", key: "SECRET", val: "secret" }]);

    const failingProc = {
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("nope\n")); controller.close(); } }),
      exited: Promise.resolve(7),
    };
    spawnSpy.mockReturnValue(failingProc as any);
    envVars = { SECRET: "pass:missing" };
    setEnvCalls = [];
    await expect(setSessionEnv("session-a")).rejects.toThrow("pass show 'missing' failed (exit 7)");
    expect(setEnvCalls).toEqual([]);
  });
});
