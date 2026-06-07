/** Extra isolated coverage for oracle stale + nickname command implementations. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Session = {
  name: string;
  windows: Array<{ index: number; name: string; active?: boolean }>;
};

type Cache = {
  local_scanned_at: string;
  oracles: any[];
};

const NOW = new Date("2026-05-18T00:00:00.000Z");
const DAY_MS = 86_400_000;

let currentCache: Cache | null = null;
let scanResult: Cache = { local_scanned_at: NOW.toISOString(), oracles: [] };
let sessions: Session[] | Error = [];
let scanCalls: string[] = [];

let execResponses = new Map<string, string | Error>();
let execCalls: Array<{ command: string; cwd: string | undefined }> = [];

let validateResult: { ok: true; value: string } | { ok: false; error: string } | null = null;
let nicknameWrites: string[] = [];
let resolvedNickname: string | null = null;
let resolveInputs: Array<{ name: string; repoPath: string | null | undefined }> = [];

const originalLog = console.log;
const originalError = console.error;

const sdkPath = import.meta.resolve("../../src/sdk");
const nicknamesPath = import.meta.resolve("../../src/core/fleet/nicknames");

mock.module(sdkPath, () => ({
  readCache: () => currentCache,
  scanAndCache: (scope: string) => {
    scanCalls.push(scope);
    currentCache = scanResult;
    return scanResult;
  },
  listSessions: async () => {
    if (sessions instanceof Error) throw sessions;
    return sessions;
  },
}));

mock.module("child_process", () => ({
  execSync: (command: string, opts?: { cwd?: string }) => {
    execCalls.push({ command, cwd: opts?.cwd });
    const response = execResponses.get(opts?.cwd ?? "");
    if (response instanceof Error) throw response;
    return response ?? "";
  },
}));

mock.module(nicknamesPath, () => ({
  validateNickname: (raw: string) => validateResult ?? { ok: true, value: raw.trim() },
  writeNickname: (repoPath: string, nickname: string) => {
    nicknameWrites.push(`write:${repoPath}:${nickname}`);
  },
  setCachedNickname: (name: string, nickname: string) => {
    nicknameWrites.push(`cache:${name}:${nickname}`);
  },
  resolveNickname: (name: string, repoPath: string | null | undefined) => {
    resolveInputs.push({ name, repoPath });
    return resolvedNickname;
  },
}));

const stale = await import("../../src/commands/plugins/oracle/impl-stale.ts?oracle-stale-nickname-extra-coverage");
const nickname = await import("../../src/commands/plugins/oracle/impl-nickname.ts?oracle-stale-nickname-extra-coverage");

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
}

function entry(patch: Record<string, unknown> = {}) {
  return {
    org: "Soul-Brews-Studio",
    repo: "oracle-repo",
    name: "oracle",
    local_path: "/repos/oracle",
    has_psi: true,
    has_fleet_config: true,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: NOW.toISOString(),
    ...patch,
  };
}

function cache(oracles: any[]): Cache {
  return { local_scanned_at: NOW.toISOString(), oracles };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function captureLog(fn: () => void | Promise<void>): Promise<string> {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

function captureError(fn: () => void): string {
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = originalError;
  }
  return logs.join("\n");
}

function restoreExitCode() {
  process.exitCode = 0;
}

beforeEach(() => {
  currentCache = cache([]);
  scanResult = cache([]);
  sessions = [];
  scanCalls = [];
  execResponses = new Map();
  execCalls = [];
  validateResult = null;
  nicknameWrites = [];
  resolvedNickname = null;
  resolveInputs = [];
  console.log = originalLog;
  console.error = originalError;
  restoreExitCode();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  restoreExitCode();
});

describe("oracle stale extra coverage", () => {
  test("classifies no-commit uncloned entries and sorts same-age ties by name", () => {
    const uncloned = stale.classifyStaleness({
      entry: entry({ name: "ghost", local_path: "" }),
      lastCommitISO: null,
      awake: false,
      now: NOW,
    });

    expect(uncloned).toMatchObject({
      name: "ghost",
      tier: "DEAD",
      days_since_commit: null,
      recommendation: "not cloned — investigate",
    });

    const sorted = stale.sortByStaleness([
      { ...uncloned, name: "zeta", days_since_commit: null },
      { ...uncloned, name: "alpha", days_since_commit: null },
    ]);
    expect(sorted.map((item: any) => item.name)).toEqual(["alpha", "zeta"]);
  });

  test("lastCommitAt covers empty path, success, empty git output, and git failure", () => {
    execResponses.set("/repos/ok", "2026-05-17T12:00:00+00:00\n");
    execResponses.set("/repos/empty", "\n");
    execResponses.set("/repos/fail", new Error("git exploded"));

    expect(stale.lastCommitAt("")).toBeNull();
    expect(stale.lastCommitAt("/repos/ok")).toBe("2026-05-17T12:00:00+00:00");
    expect(stale.lastCommitAt("/repos/empty")).toBeNull();
    expect(stale.lastCommitAt("/repos/fail")).toBeNull();
    expect(execCalls).toEqual([
      { command: "git log -1 --format=%cI", cwd: "/repos/ok" },
      { command: "git log -1 --format=%cI", cwd: "/repos/empty" },
      { command: "git log -1 --format=%cI", cwd: "/repos/fail" },
    ]);
  });

  test("runStaleScan uses cache fallback scan, tmux awake windows, and tmux error recovery", async () => {
    currentCache = null;
    scanResult = cache([
      entry({ name: "awake", local_path: "/repos/awake" }),
      entry({ name: "dusty", local_path: "/repos/dusty" }),
    ]);
    sessions = [{ name: "work", windows: [{ index: 0, name: "awake-oracle" }, { index: 1, name: "notes" }] }];

    const first = await stale.runStaleScan(
      { all: true },
      {
        getLastCommit: (localPath: string) => (localPath.includes("awake") ? iso(200) : iso(45)),
        now: () => NOW,
      },
    );

    expect(scanCalls).toEqual(["local"]);
    expect(Object.fromEntries(first.map((item: any) => [item.name, item.tier]))).toEqual({
      awake: "ACTIVE",
      dusty: "STALE",
    });

    currentCache = cache([entry({ name: "sleeping", local_path: "/repos/sleeping" })]);
    sessions = new Error("tmux unavailable");

    const second = await stale.runStaleScan(
      { all: true },
      {
        getLastCommit: () => iso(60),
        now: () => NOW,
      },
    );

    expect(second).toMatchObject([{ name: "sleeping", awake: false, tier: "STALE" }]);
  });

  test("cmdOracleScanStale prints json, all-clear, and all-tier formatted output", async () => {
    currentCache = cache([entry({ name: "dead", local_path: "/repos/dead", has_psi: false })]);
    execResponses.set("/repos/dead", iso(120));

    const jsonOut = await captureLog(() => stale.cmdOracleScanStale({ json: true }));
    const parsed = JSON.parse(jsonOut);
    expect(parsed).toMatchObject({ schema: 1, count: 1 });
    expect(parsed.oracles[0]).toMatchObject({
      name: "dead",
      tier: "DEAD",
      recommendation: "prune candidate (no ψ/)",
    });

    currentCache = cache([entry({ name: "fresh", local_path: "/repos/fresh" })]);
    execResponses.set("/repos/fresh", iso(1));

    const clearOut = stripAnsi(await captureLog(() => stale.cmdOracleScanStale()));
    expect(clearOut).toContain("No stale oracles — all clear.");

    currentCache = cache([
      entry({ name: "ghost", local_path: "" }),
      entry({ name: "dusty", local_path: "/repos/dusty" }),
      entry({ name: "slowpoke", local_path: "/repos/slowpoke" }),
      entry({ name: "fresh", local_path: "/repos/fresh" }),
      entry({ name: "awake", local_path: "/repos/awake" }),
    ]);
    sessions = [{ name: "live", windows: [{ index: 0, name: "awake-oracle" }] }];
    execResponses.set("/repos/dusty", iso(45));
    execResponses.set("/repos/slowpoke", iso(15));
    execResponses.set("/repos/fresh", iso(1));
    execResponses.set("/repos/awake", iso(200));

    const formatted = stripAnsi(await captureLog(() => stale.cmdOracleScanStale({ all: true })));

    expect(formatted).toContain("Stale oracle scan  (DEAD 1  STALE 1  SLOW 1  ACTIVE 2)");
    expect(formatted).toContain("DEAD");
    expect(formatted).toContain("STALE");
    expect(formatted).toContain("SLOW");
    expect(formatted).toContain("ACTIVE");
    expect(formatted).toContain("ghost");
    expect(formatted).toContain("? ago");
    expect(formatted).toContain("not cloned — investigate");
    expect(formatted).toContain("awake in tmux");
  });
});

describe("oracle nickname command extra coverage", () => {
  test("set-nickname rejects missing names, unknown entries, uncloned entries, and validation errors", () => {
    expect(() => nickname.cmdOracleSetNickname("", "Moe")).toThrow(
      'usage: maw oracle set-nickname <oracle> "<nickname>"',
    );

    currentCache = null;
    expect(() => nickname.cmdOracleSetNickname("missing", "Moe")).toThrow(
      "oracle 'missing' not found in registry",
    );

    currentCache = cache([entry({ name: "ghost", local_path: "" })]);
    expect(() => nickname.cmdOracleSetNickname("ghost", "Moe")).toThrow(
      "oracle 'ghost' has no local path",
    );

    currentCache = cache([entry({ name: "neo", local_path: "/repos/neo" })]);
    validateResult = { ok: false, error: "nickname must be a single line (no newlines)" };
    expect(() => nickname.cmdOracleSetNickname("neo", "bad\nname")).toThrow(
      "nickname must be a single line",
    );
    expect(nicknameWrites).toEqual([]);
  });

  test("set-nickname writes disk before cache and reports json, clear, and formatted success", async () => {
    currentCache = cache([entry({ name: "neo", local_path: "/repos/neo" })]);
    validateResult = { ok: true, value: "Moe" };

    const jsonOut = await captureLog(() => nickname.cmdOracleSetNickname("neo", "  Moe  ", { json: true }));
    expect(JSON.parse(jsonOut)).toEqual({
      schema: 1,
      name: "neo",
      nickname: "Moe",
      cleared: false,
    });
    expect(nicknameWrites).toEqual(["write:/repos/neo:Moe", "cache:neo:Moe"]);

    validateResult = { ok: true, value: "" };
    nicknameWrites = [];

    const clearOut = stripAnsi(await captureLog(() => nickname.cmdOracleSetNickname("neo", "   ")));
    expect(clearOut).toContain("cleared nickname for neo");
    expect(nicknameWrites).toEqual(["write:/repos/neo:", "cache:neo:"]);

    validateResult = { ok: true, value: "Trinity" };

    const formattedOut = stripAnsi(await captureLog(() => nickname.cmdOracleSetNickname("neo", "Trinity")));
    expect(formattedOut).toContain("neo nickname set to Trinity");
  });

  test("get-nickname reports json values and no-value CLI errors without requiring a registry hit", async () => {
    expect(() => nickname.cmdOracleGetNickname("")).toThrow("usage: maw oracle get-nickname <oracle>");

    currentCache = cache([entry({ name: "neo", local_path: "/repos/neo" })]);
    resolvedNickname = "Moe";

    const jsonOut = await captureLog(() => nickname.cmdOracleGetNickname("neo", { json: true }));
    expect(JSON.parse(jsonOut)).toEqual({ schema: 1, name: "neo", nickname: "Moe" });
    expect(resolveInputs).toEqual([{ name: "neo", repoPath: "/repos/neo" }]);

    currentCache = cache([]);
    resolvedNickname = null;
    resolveInputs = [];

    const errOut = stripAnsi(captureError(() => nickname.cmdOracleGetNickname("missing")));
    expect(errOut).toContain("no nickname set for missing");
    expect(process.exitCode).toBe(1);
    restoreExitCode();
    expect(resolveInputs).toEqual([{ name: "missing", repoPath: null }]);
  });
});
