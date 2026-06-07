/**
 * Fifteenth-pass isolated function coverage for wake-resolve-impl.
 *
 * Fully mocked: covers remaining helper callbacks and resolver fallbacks without
 * touching live ghq, tmux, GitHub, fleet state, pass, or federation peers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const fleetRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-15-fleet-"));
const tempRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-15-temp-"));

type OracleResult =
  | { kind: "not-found" }
  | { kind: "exact"; oracle: { owner: string; repo: string; path?: string } }
  | { kind: "ambiguous"; candidates: Array<{ owner: string; repo: string; path?: string }> };

let config: any;
let envVars: Record<string, string>;
let sessions: Array<{ name: string }>;
let ghqListValue: string[];
let ghqFindMap: Record<string, string | null>;
let ghqFindImpl: ((query: string) => Promise<string | null>) | null;
let resolveResults: OracleResult[];
let scanWorktreesResult: Array<{ path: string; mainRepo: string }>;
let scanWorktreesThrows: boolean;
let scanSuggestResult: any;
let scanSuggestThrows: boolean;
let hostExecCalls: string[];
let hostExecHandler: (cmd: string) => Promise<string>;
let curlFetchCalls: Array<{ url: string; init: any }>;
let curlFetchHandler: (url: string, init?: any) => Promise<any>;
let setEnvCalls: Array<{ session: string; key: string; val: string }>;
let logs: string[];
let errors: string[];
let exitCodes: number[];
let spawnSpy: ReturnType<typeof spyOn> | null;

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;

function resetFleetDir(): void {
  rmSync(fleetRoot, { recursive: true, force: true });
  mkdirSync(fleetRoot, { recursive: true });
}

function writeFleet(name: string, body: unknown): void {
  writeFileSync(join(fleetRoot, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

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
  ghqList: async () => ghqListValue,
  ghqFind: async (query: string) => ghqFindImpl ? ghqFindImpl(query) : (ghqFindMap[query] ?? null),
}));

mock.module(join(srcRoot, "src/core/resolve"), () => ({
  resolveOracle: async () => resolveResults.shift() ?? { kind: "not-found" },
  pickOracle: async () => null,
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => {
    if (scanWorktreesThrows) throw new Error("scan unavailable");
    return scanWorktreesResult;
  },
}));

mock.module(join(srcRoot, "src/commands/shared/wake-resolve-scan-suggest"), () => ({
  scanSuggestOracle: async () => {
    if (scanSuggestThrows) throw new Error("scan suggest unavailable");
    return scanSuggestResult;
  },
}));

const {
  detectSession,
  findReusableWorktreeBySlug,
  resolveFromWorktrees,
  resolveLocalOracleRepoName,
  resolveOracle,
  sanitizeBranchName,
  setSessionEnv,
} = await import("../../src/commands/shared/wake-resolve-impl");

beforeEach(() => {
  resetFleetDir();
  config = { githubOrg: "FallbackOrg", githubOrgs: undefined, peers: [], sessions: {} };
  envVars = {};
  sessions = [];
  ghqListValue = [];
  ghqFindMap = {};
  ghqFindImpl = null;
  resolveResults = [{ kind: "not-found" }];
  scanWorktreesResult = [];
  scanWorktreesThrows = false;
  scanSuggestResult = null;
  scanSuggestThrows = false;
  hostExecCalls = [];
  hostExecHandler = async () => "";
  curlFetchCalls = [];
  curlFetchHandler = async () => ({ ok: false });
  setEnvCalls = [];
  logs = [];
  errors = [];
  exitCodes = [];
  spawnSpy = null;

  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
});

afterEach(() => {
  spawnSpy?.mockRestore();
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
});

afterAll(() => {
  rmSync(fleetRoot, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("pure wake resolver helpers", () => {
  test("resolveFromWorktrees handles .git, bare common-dir, missing common-dir, and missing main repo", async () => {
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
  });

  test("resolveLocalOracleRepoName exercises exact, fuzzy, ambiguous, numeric, slug, and empty outcomes", () => {
    const repos = [
      "github.com/Soul-Brews-Studio/mawjs-codex-oracle",
      "github.com/Soul-Brews-Studio/mawjs-oracle",
      "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
      "github.com/Alt/pulse-oracle",
      "github.com/Other/pulse-oracle",
      "not-an-oracle",
    ];

    expect(resolveLocalOracleRepoName("48-mawjs-codex", repos)).toEqual({ kind: "exact", match: "mawjs-codex-oracle" });
    expect(resolveLocalOracleRepoName("v3", repos)).toEqual({ kind: "fuzzy", match: "arra-oracle-v3-oracle" });
    expect(resolveLocalOracleRepoName("pulse", repos)).toEqual({
      kind: "ambiguous",
      candidates: ["Alt/pulse-oracle", "Other/pulse-oracle"],
    });
    expect(resolveLocalOracleRepoName("", repos)).toEqual({ kind: "none" });
    expect(resolveLocalOracleRepoName("ghost", repos)).toEqual({ kind: "none" });
  });

  test("sanitizeBranchName and reusable worktree scoping cover helper callbacks", () => {
    expect(sanitizeBranchName("  Feature: Pulse Board!!...  ")).toBe("feature-pulse-board");
    expect(sanitizeBranchName("--")).toBe("");
    expect(sanitizeBranchName("x".repeat(80))).toHaveLength(50);

    const parentDir = join(tempRoot, "reuse-scope");
    rmSync(parentDir, { recursive: true, force: true });
    mkdirSync(parentDir, { recursive: true });
    expect(findReusableWorktreeBySlug(parentDir, "blue", "neo-oracle", {
      readdirSync: () => ["other-oracle.wt-1-blue", "neo-oracle.wt-2-blue", "neo-oracle.wt-3-red"] as any,
      statSync: (() => ({ isDirectory: () => true })) as any,
    })).toEqual({ path: join(parentDir, "neo-oracle.wt-2-blue"), name: "2-blue" });
  });
});

describe("resolveOracle fallback branches", () => {
  test("uses substring local resolver after an exact miss and logs fuzzy matches", async () => {
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
  });

  test("returns fleet-configured repos that are already cloned", async () => {
    writeFleet("22-neo", { windows: [{ name: "neo-oracle", repo: "Org/neo-oracle" }] });
    ghqFindMap["/neo-oracle"] = "/repos/Org/neo-oracle";

    await expect(resolveOracle("neo")).resolves.toEqual({
      repoPath: "/repos/Org/neo-oracle",
      repoName: "neo-oracle",
      parentDir: "/repos/Org",
    });
  });

  test("uses fleet-pinned ghq recheck, clone success, and clone failure exits", async () => {
    writeFleet("23-pin", { windows: [{ name: "pin-oracle", repo: "Org/pin-oracle" }] });
    let findCount = 0;
    ghqFindImpl = async () => (++findCount === 1 ? null : "/repos/Org/pin-oracle");

    await expect(resolveOracle("pin")).resolves.toEqual({
      repoPath: "/repos/Org/pin-oracle",
      repoName: "pin-oracle",
      parentDir: "/repos/Org",
    });
    expect(hostExecCalls).toEqual([]);

    resetFleetDir();
    writeFleet("24-clone", { windows: [{ name: "clone-oracle", repo: "Org/clone-oracle" }] });
    ghqFindImpl = async (query) => ghqFindMap[query] ?? null;
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
    writeFleet("25-broken", { windows: [{ name: "broken-oracle", repo: "Org/broken-oracle" }] });
    ghqFindMap = {};
    hostExecHandler = async () => { throw new Error("network down\nmore"); };
    await expect(resolveOracle("broken")).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("fleet-pinned Org/broken-oracle clone/update failed: network down");
    expect(errors.join("\n")).toContain("clone failed and not found locally");
    expect(exitCodes).toContain(1);
  });

  test("probes configured orgs, reports clone failures, and returns later local clones", async () => {
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

    ghqFindImpl = null;
    ghqFindMap = {};
    hostExecCalls = [];
    hostExecHandler = async (cmd) => {
      if (cmd.includes("ghq get")) throw new Error("clone refused\nextra");
      if (cmd.includes("Found/flaky-oracle")) return "{}";
      throw new Error("missing");
    };
    scanSuggestResult = { repoPath: "/suggested/flaky-oracle", repoName: "flaky-oracle", parentDir: "/suggested" };
    await expect(resolveOracle("flaky")).resolves.toEqual(scanSuggestResult);
    expect(errors.join("\n")).toContain("clone failed for Found/flaky-oracle: clone refused");
  });

  test("wakes peer-hosted sessions, tolerates peer errors, and exits when scan-suggest throws", async () => {
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
    expect(curlFetchCalls.at(-1)!.init.from).toBe("auto");
    expect(exitCodes).toContain(0);

    curlFetchCalls = [];
    exitCodes = [];
    errors = [];
    config.peers = ["http://none"];
    curlFetchHandler = async () => ({ ok: false });
    scanSuggestThrows = true;
    await expect(resolveOracle("missing")).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("oracle repo not found: missing");
    expect(exitCodes).toContain(1);
  });
});

describe("detectSession and setSessionEnv uncovered function paths", () => {
  test("detectSession covers URL-numbered, numeric, prefix, and generic ambiguities", async () => {
    sessions = [{ name: "77-wireboy-oracle" }];
    await expect(detectSession("wireboy", "wireboy-oracle")).resolves.toBe("77-wireboy-oracle");

    sessions = [{ name: "11-pulse-oracle" }, { name: "12-pulse-oracle" }];
    await expect(detectSession("pulse", "pulse-oracle")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("pulse-oracle");
    expect(errors.join("\n")).toContain("is ambiguous");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "47-mawjs" }, { name: "48-mawjs" }];
    await expect(detectSession("mawjs")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("mawjs");
    expect(errors.join("\n")).toContain("matches 2 fleet sessions");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "20-homekeeper" }, { name: "21-homekey" }];
    await expect(detectSession("homeke")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("homeke");
    expect(errors.join("\n")).toContain("is ambiguous");

    errors = [];
    exitCodes = [];
    sessions = [{ name: "neo-alpha" }, { name: "neo-beta" }];
    await expect(detectSession("neo")).resolves.toBeNull();
    expect(errors.join("\n")).toContain("matches 2 sessions");
  });

  test("setSessionEnv sets plain values and reports failing pass secrets", async () => {
    envVars = { FOO: "bar", EMPTY: "" };
    await setSessionEnv("session-a");
    expect(setEnvCalls).toEqual([
      { session: "session-a", key: "FOO", val: "bar" },
      { session: "session-a", key: "EMPTY", val: "" },
    ]);

    envVars = { SECRET: "pass:missing" };
    setEnvCalls = [];
    const fakeProc = {
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("nope\n")); controller.close(); } }),
      exited: Promise.resolve(7),
    };
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc as any);

    await expect(setSessionEnv("session-a")).rejects.toThrow("pass show 'missing' failed (exit 7)");
    expect(setEnvCalls).toEqual([]);
  });
});
