/**
 * Runtime coverage for wake-resolve-impl without touching live ghq, tmux,
 * GitHub, or federation peers. Mocks are gated and delegate when inactive so
 * this main-suite file contributes to `test:coverage` without polluting others.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WorktreeInfo } from "../src/core/fleet/worktrees-scan";

const fleetRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-fleet-"));
const tempRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-runtime-"));

const _rSdk = await import("../src/sdk");
const _rConfig = await import("../src/config");
const _rGhq = await import("../src/core/ghq");
const _rWorktrees = await import("../src/core/fleet/worktrees-scan");
const _rScanSuggest = await import("../src/commands/shared/wake-resolve-scan-suggest");

const realSdk = {
  hostExec: _rSdk.hostExec,
  curlFetch: _rSdk.curlFetch,
  tmux: {
    listSessions: _rSdk.tmux.listSessions.bind(_rSdk.tmux),
    setEnvironment: _rSdk.tmux.setEnvironment.bind(_rSdk.tmux),
  },
};
const realConfig = {
  loadConfig: _rConfig.loadConfig,
  getEnvVars: _rConfig.getEnvVars,
};
const realGhq = {
  ghqFind: _rGhq.ghqFind,
  ghqList: _rGhq.ghqList,
};
const realWorktrees = { scanWorktrees: _rWorktrees.scanWorktrees };
const realScanSuggest = { scanSuggestOracle: _rScanSuggest.scanSuggestOracle };

let mockActive = false;
let config: any;
let envVars: Record<string, string>;
let sessions: Array<{ name: string }>;
let ghqListValue: string[];
let ghqListError: Error | null;
let ghqFindMap: Record<string, string | null>;
let ghqFindImpl: ((query: string) => Promise<string | null>) | null;
let worktreeList: WorktreeInfo[];
let scanWorktreesError: Error | null;
let scanSuggestResult: any;
let hostExecImpl: (cmd: string) => Promise<string>;
let curlFetchImpl: (url: string, init?: any) => Promise<any>;

let logs: string[];
let errors: string[];
let hostExecCalls: string[];
let ghqFindCalls: string[];
let curlFetchCalls: Array<{ url: string; init: any }>;
let setEnvCalls: Array<{ session: string; key: string; val: string }>;
let exitCalls: number[];

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
let spawnSpy: ReturnType<typeof spyOn> | null = null;

function setSessionEnvTestDeps() {
  return {
    getEnvVars: () => envVars,
    setEnvironment: async (session: string, key: string, val: string) => {
      setEnvCalls.push({ session, key, val });
    },
    spawn: Bun.spawn,
  };
}

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ..._rSdk,
  FLEET_DIR: fleetRoot,
  hostExec: async (cmd: string) => {
    if (!mockActive) return realSdk.hostExec(cmd);
    hostExecCalls.push(cmd);
    return hostExecImpl(cmd);
  },
  curlFetch: async (url: string, init?: any) => {
    if (!mockActive) return realSdk.curlFetch(url, init);
    curlFetchCalls.push({ url, init });
    return curlFetchImpl(url, init);
  },
  tmux: {
    ..._rSdk.tmux,
    listSessions: async () => (mockActive ? sessions : realSdk.tmux.listSessions()),
    setEnvironment: async (session: string, key: string, val: string) => {
      if (!mockActive) return realSdk.tmux.setEnvironment(session, key, val);
      setEnvCalls.push({ session, key, val });
    },
  },
}));

mock.module(join(import.meta.dir, "../src/config"), () => ({
  ..._rConfig,
  loadConfig: () => (mockActive ? config : realConfig.loadConfig()),
  getEnvVars: () => (mockActive ? envVars : realConfig.getEnvVars()),
}));

mock.module(join(import.meta.dir, "../src/core/ghq"), () => ({
  ..._rGhq,
  ghqList: async () => {
    if (!mockActive) return realGhq.ghqList();
    if (ghqListError) throw ghqListError;
    return ghqListValue;
  },
  ghqFind: async (query: string) => {
    if (!mockActive) return realGhq.ghqFind(query);
    ghqFindCalls.push(query);
    if (ghqFindImpl) return ghqFindImpl(query);
    return ghqFindMap[query] ?? null;
  },
}));

mock.module(join(import.meta.dir, "../src/core/fleet/worktrees-scan"), () => ({
  ..._rWorktrees,
  scanWorktrees: async () => {
    if (!mockActive) return realWorktrees.scanWorktrees();
    if (scanWorktreesError) throw scanWorktreesError;
    return worktreeList;
  },
}));

mock.module(join(import.meta.dir, "../src/commands/shared/wake-resolve-scan-suggest"), () => ({
  ..._rScanSuggest,
  scanSuggestOracle: async (...args: Parameters<typeof _rScanSuggest.scanSuggestOracle>) => {
    if (!mockActive) return realScanSuggest.scanSuggestOracle(...args);
    return scanSuggestResult;
  },
}));

const {
  detectSession,
  findReusableWorktreeBySlug,
  findWorktrees,
  resolveOracle,
  setSessionEnv,
} = await import("../src/commands/shared/wake-resolve-impl");

function resetFleetDir(): void {
  rmSync(fleetRoot, { recursive: true, force: true });
  mkdirSync(fleetRoot, { recursive: true });
}

function writeFleet(name: string, windows: any[]): void {
  writeFileSync(join(fleetRoot, `${name}.json`), JSON.stringify({ name, windows }, null, 2));
}

function worktree(path: string, mainRepo: string): WorktreeInfo {
  return { path, mainRepo, branch: "feature/test", wtName: path.split("/").pop() ?? "wt", isCurrent: false };
}

beforeEach(() => {
  mockActive = true;
  resetFleetDir();
  config = { githubOrgs: ["Soul-Brews-Studio"], peers: [], sessions: {} };
  envVars = {};
  sessions = [];
  ghqListValue = [];
  ghqListError = null;
  ghqFindMap = {};
  ghqFindImpl = null;
  worktreeList = [];
  scanWorktreesError = null;
  scanSuggestResult = null;
  hostExecImpl = async () => "";
  curlFetchImpl = async () => ({ ok: false });

  logs = [];
  errors = [];
  hostExecCalls = [];
  ghqFindCalls = [];
  curlFetchCalls = [];
  setEnvCalls = [];
  exitCalls = [];

  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
});

afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = null;
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  mockActive = false;
});

afterAll(() => {
  rmSync(fleetRoot, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("resolveOracle runtime paths", () => {
  test("prefers exact local ghq oracle repos and fuzzy-matches only after exact misses", async () => {
    ghqListValue = [
      "github.com/Soul-Brews-Studio/mawjs-oracle",
      "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
    ];

    await expect(resolveOracle("mawjs")).resolves.toEqual({
      repoPath: "github.com/Soul-Brews-Studio/mawjs-oracle",
      repoName: "mawjs-oracle",
      parentDir: "github.com/Soul-Brews-Studio",
    });

    await expect(resolveOracle("v3")).resolves.toEqual({
      repoPath: "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
      repoName: "arra-oracle-v3-oracle",
      parentDir: "github.com/Soul-Brews-Studio",
    });
    expect(logs.some((line) => line.includes("fuzzy match: arra-oracle-v3-oracle"))).toBe(true);
    expect(hostExecCalls).toEqual([]);
  });

  test("uses fleet configs to find existing cloned repos", async () => {
    writeFleet("47-mawjs", [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }]);
    ghqFindMap["/mawjs-oracle"] = "/repos/Soul-Brews-Studio/mawjs-oracle";

    await expect(resolveOracle("mawjs")).resolves.toEqual({
      repoPath: "/repos/Soul-Brews-Studio/mawjs-oracle",
      repoName: "mawjs-oracle",
      parentDir: "/repos/Soul-Brews-Studio",
    });
    expect(ghqFindCalls).toContain("/mawjs-oracle");
  });

  test("surfaces ambiguous local oracle repos before remote fallbacks", async () => {
    ghqListValue = [
      "github.com/laris-co/pulse-oracle",
      "github.com/Soul-Brews-Studio/pulse-oracle",
    ];
    scanSuggestResult = { repoPath: "/after/ambiguous", repoName: "after", parentDir: "/after" };

    await expect(resolveOracle("pulse")).resolves.toEqual(scanSuggestResult);

    expect(exitCalls).toContain(1);
    expect(errors.some((line) => line.includes("'pulse' matches 2 local oracles"))).toBe(true);
    expect(errors.some((line) => line.includes("laris-co/pulse-oracle"))).toBe(true);
    expect(errors.some((line) => line.includes("maw wake <org>/<repo>"))).toBe(true);
  });

  test("falls back to worktree-discovered main repos when ghq and fleet miss", async () => {
    const mainRepo = join(tempRoot, "worktree-main", "mawjs-oracle");
    mkdirSync(mainRepo, { recursive: true });
    worktreeList = [worktree(join(tempRoot, "mawjs-oracle.wt-1"), "github.com/Org/mawjs-oracle")];
    hostExecImpl = async (cmd) => {
      expect(cmd).toContain("rev-parse --git-common-dir");
      return `${mainRepo}/.git\n`;
    };

    await expect(resolveOracle("mawjs")).resolves.toEqual({
      repoPath: mainRepo,
      repoName: "mawjs-oracle",
      parentDir: mainRepo.replace(/\/[^/]+$/, ""),
    });
  });

  test("clones a fleet-pinned repo when it is not already local", async () => {
    writeFleet("12-special", [{ name: "special-oracle", repo: "Org/special-oracle" }]);
    ghqFindImpl = async (query) => ghqFindMap[query] ?? null;
    hostExecImpl = async (cmd) => {
      if (cmd.includes("ghq get -u 'github.com/Org/special-oracle'")) {
        ghqFindMap["/special-oracle"] = "/repos/Org/special-oracle";
      }
      return "";
    };

    await expect(resolveOracle("special")).resolves.toEqual({
      repoPath: "/repos/Org/special-oracle",
      repoName: "special-oracle",
      parentDir: "/repos/Org",
    });
    expect(logs.some((line) => line.includes("special pinned in fleet"))).toBe(true);
    expect(logs.some((line) => line.includes("found at /repos/Org/special-oracle"))).toBe(true);
  });

  test("re-checks fleet-pinned repos before cloning and reports failed fleet clones", async () => {
    writeFleet("12-special", [{ name: "special-oracle", repo: "Org/special-oracle" }]);
    let findCount = 0;
    ghqFindImpl = async () => (++findCount === 1 ? null : "/repos/Org/special-oracle");

    await expect(resolveOracle("special")).resolves.toEqual({
      repoPath: "/repos/Org/special-oracle",
      repoName: "special-oracle",
      parentDir: "/repos/Org",
    });
    expect(hostExecCalls).toEqual([]);

    resetFleetDir();
    writeFleet("13-broken", [{ name: "broken-oracle", repo: "Org/broken-oracle" }]);
    findCount = 0;
    ghqFindImpl = async () => null;
    hostExecImpl = async () => { throw new Error("network down\nmore detail"); };
    scanSuggestResult = { repoPath: "/after/fleet-fail", repoName: "after", parentDir: "/after" };

    await expect(resolveOracle("broken")).resolves.toEqual(scanSuggestResult);

    expect(errors.some((line) => line.includes("fleet-pinned Org/broken-oracle clone/update failed: network down"))).toBe(true);
    expect(errors.some((line) => line.includes("fleet-pinned Org/broken-oracle — clone failed"))).toBe(true);
    expect(errors.some((line) => line.includes("ghq get -u 'github.com/Org/broken-oracle'"))).toBe(true);
    expect(exitCalls).toContain(1);
  });

  test("probes configured GitHub orgs and clones the first visible oracle repo", async () => {
    config.githubOrgs = ["MissingOrg", "FoundOrg"];
    hostExecImpl = async (cmd) => {
      if (cmd.includes("gh repo view 'MissingOrg/neo-oracle'")) throw new Error("missing");
      if (cmd.includes("gh repo view 'FoundOrg/neo-oracle'")) return '{"name":"neo-oracle"}';
      if (cmd.includes("ghq get -u 'github.com/FoundOrg/neo-oracle'")) {
        ghqFindMap["/neo-oracle"] = "/repos/FoundOrg/neo-oracle";
      }
      return "";
    };

    await expect(resolveOracle("neo")).resolves.toEqual({
      repoPath: "/repos/FoundOrg/neo-oracle",
      repoName: "neo-oracle",
      parentDir: "/repos/FoundOrg",
    });
    expect(hostExecCalls).toContain("gh repo view 'MissingOrg/neo-oracle' --json name 2>/dev/null");
    expect(hostExecCalls).toContain("gh repo view 'FoundOrg/neo-oracle' --json name 2>/dev/null");
  });

  test("continues past clone failures while probing configured GitHub orgs", async () => {
    config.githubOrgs = ["FoundOrg"];
    hostExecImpl = async (cmd) => {
      if (cmd.includes("gh repo view 'FoundOrg/flaky-oracle'")) return '{"name":"flaky-oracle"}';
      if (cmd.includes("ghq get -u 'github.com/FoundOrg/flaky-oracle'")) throw new Error("clone refused\nextra");
      return "";
    };
    scanSuggestResult = { repoPath: "/suggested/flaky-oracle", repoName: "flaky-oracle", parentDir: "/suggested" };

    await expect(resolveOracle("flaky")).resolves.toEqual(scanSuggestResult);

    expect(errors.some((line) => line.includes("clone failed for FoundOrg/flaky-oracle: clone refused"))).toBe(true);
  });

  test("wakes a peer-hosted oracle through federation and signs the send request", async () => {
    config.peers = ["http://peer-a"];
    curlFetchImpl = async (url, init) => {
      if (url.endsWith("/api/sessions")) {
        return { ok: true, data: [{ name: "88-neo", windows: [{ index: 2, name: "neo-oracle" }] }] };
      }
      if (url.endsWith("/api/send")) return { ok: true, data: { ok: true, init } };
      return { ok: false };
    };
    scanSuggestResult = { repoPath: "/after/exit", repoName: "after", parentDir: "/after" };

    await resolveOracle("neo");

    expect(curlFetchCalls[0]).toMatchObject({ url: "http://peer-a/api/sessions" });
    expect(curlFetchCalls[1]).toMatchObject({ url: "http://peer-a/api/send" });
    expect(curlFetchCalls[1]!.init).toMatchObject({ method: "POST", from: "auto" });
    expect(JSON.parse(curlFetchCalls[1]!.init.body)).toEqual({ target: "88-neo:2", text: "" });
    expect(exitCalls).toContain(0);
  });

  test("returns scan-suggest results and exits loudly when every resolution path fails", async () => {
    scanSuggestResult = { repoPath: "/suggested/ghost-oracle", repoName: "ghost-oracle", parentDir: "/suggested" };
    await expect(resolveOracle("ghost", { allLocal: true })).resolves.toEqual(scanSuggestResult);

    scanSuggestResult = null;
    config.peers = ["http://peer-a", "http://peer-b"];
    await expect(resolveOracle("missing")).resolves.toBeUndefined();

    expect(errors.some((line) => line.includes("oracle repo not found: missing"))).toBe(true);
    expect(errors.some((line) => line.includes("2 peers"))).toBe(true);
    expect(exitCalls).toContain(1);
  });
});

describe("findWorktrees and detectSession runtime paths", () => {
  test("findWorktrees maps shell glob output into wake worktree records", async () => {
    hostExecImpl = async (cmd) => {
      expect(cmd).toBe("ls -d /repos/mawjs-oracle.wt-* 2>/dev/null || true");
      return "/repos/mawjs-oracle.wt-feature\n/repos/mawjs-oracle.wt-2-bug\n";
    };

    await expect(findWorktrees("/repos", "mawjs-oracle")).resolves.toEqual([
      { path: "/repos/mawjs-oracle.wt-feature", name: "feature" },
      { path: "/repos/mawjs-oracle.wt-2-bug", name: "2-bug" },
    ]);
  });

  test("findReusableWorktreeBySlug finds matching slug across repo names in the org path", () => {
    const orgDir = join(tempRoot, "laris-co");
    rmSync(orgDir, { recursive: true, force: true });
    mkdirSync(join(orgDir, "homelab.wt-1-blue"), { recursive: true });
    mkdirSync(join(orgDir, "homekeeper-oracle.wt-2-white"), { recursive: true });
    writeFileSync(join(orgDir, "not-a-dir.wt-3-white"), "file");

    expect(findReusableWorktreeBySlug(orgDir, "white")).toEqual({
      path: join(orgDir, "homekeeper-oracle.wt-2-white"),
      name: "2-white",
    });
    expect(findReusableWorktreeBySlug(orgDir, "missing")).toBeNull();
    expect(findReusableWorktreeBySlug(join(orgDir, "missing"), "white")).toBeNull();
  });

  test("detectSession honors configured maps, URL repo names, and numbered URL sessions", async () => {
    config.sessions = { neo: "mapped-neo" };
    sessions = [{ name: "mapped-neo" }, { name: "m5-oracle" }, { name: "77-wireboy-oracle" }];

    await expect(detectSession("neo")).resolves.toBe("mapped-neo");

    config.sessions = {};
    await expect(detectSession("m5", "m5-oracle")).resolves.toBe("m5-oracle");
    await expect(detectSession("wireboy", "wireboy-oracle")).resolves.toBe("77-wireboy-oracle");
    await expect(detectSession("ghost", "ghost-oracle")).resolves.toBeNull();
  });

  test("detectSession fails loud for ambiguous URL and numeric fleet sessions", async () => {
    sessions = [{ name: "11-pulse-oracle" }, { name: "12-pulse-oracle" }];
    await expect(detectSession("pulse", "pulse-oracle")).resolves.toBeNull();
    expect(exitCalls).toContain(1);
    expect(errors.some((line) => line.includes("'pulse-oracle' is ambiguous"))).toBe(true);

    exitCalls = [];
    errors = [];
    sessions = [{ name: "47-mawjs" }, { name: "54-mawjs" }];
    await expect(detectSession("mawjs")).resolves.toBeNull();
    expect(exitCalls).toContain(1);
    expect(errors.some((line) => line.includes("'mawjs' is ambiguous"))).toBe(true);
  });

  test("detectSession resolves numeric fleet, canonical non-view matches, and ambiguous canonical matches", async () => {
    sessions = [{ name: "48-mawjs-codex" }, { name: "mawjs-codex-view" }, { name: "maw-pty-1" }];
    await expect(detectSession("mawjs-codex")).resolves.toBe("48-mawjs-codex");

    sessions = [{ name: "mawjs-oracle-view" }, { name: "maw-pty-2" }, { name: "mawjs-oracle" }];
    await expect(detectSession("mawjs-oracle")).resolves.toBe("mawjs-oracle");

    exitCalls = [];
    errors = [];
    sessions = [{ name: "neo-alpha" }, { name: "neo-beta" }];
    await expect(detectSession("neo")).resolves.toBeNull();
    expect(exitCalls).toContain(1);
    expect(errors.some((line) => line.includes("matches 2 sessions"))).toBe(true);
  });

  test("detectSession falls back to fleet session configs only when that session is live", async () => {
    writeFleet("fleet-neo", [{ name: "neo-oracle" }]);
    sessions = [{ name: "fleet-neo" }];
    await expect(detectSession("neo")).resolves.toBe("fleet-neo");

    sessions = [];
    await expect(detectSession("neo")).resolves.toBeNull();
  });
});

describe("setSessionEnv runtime paths", () => {
  test("sets plain environment variables directly", async () => {
    envVars = { FOO: "bar", EMPTY: "" };
    spawnSpy = spyOn(Bun, "spawn");

    await setSessionEnv("mysession", setSessionEnvTestDeps());

    expect(setEnvCalls).toEqual([
      { session: "mysession", key: "FOO", val: "bar" },
      { session: "mysession", key: "EMPTY", val: "" },
    ]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("resolves pass: secrets through Bun.spawn and trims trailing newlines", async () => {
    envVars = { SECRET: "pass:path/to/secret" };
    const fakeProc = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("resolved\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(0),
    };
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc as any);

    await setSessionEnv("mysession", setSessionEnvTestDeps());

    expect(spawnSpy).toHaveBeenCalledWith(["pass", "show", "path/to/secret"], { stdout: "pipe", stderr: "pipe" });
    expect(setEnvCalls).toEqual([{ session: "mysession", key: "SECRET", val: "resolved" }]);
  });

  test("throws and does not set env when pass exits non-zero", async () => {
    envVars = { SECRET: "pass:missing" };
    const fakeProc = {
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not found\n"));
          controller.close();
        },
      }),
      exited: Promise.resolve(2),
    };
    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc as any);

    await expect(setSessionEnv("mysession", setSessionEnvTestDeps())).rejects.toThrow("pass show 'missing' failed (exit 2)");
    expect(setEnvCalls).toEqual([]);
  });
});
