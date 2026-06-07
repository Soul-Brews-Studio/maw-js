/** Targeted isolated coverage for src/commands/plugins/oracle/impl-about.ts. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_FLEET_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-about-fleet-"));

type Session = {
  name: string;
  windows?: Array<{ index: number; name: string }>;
};

type ResolveOracleResult = {
  repoPath: string | null;
  repoName: string;
  parentDir: string | null;
};

let sessions: Session[] = [];
let detectedSession: string | null = null;
let resolveResult: ResolveOracleResult = { repoPath: null, repoName: "", parentDir: null };
let worktrees: Array<{ name: string; path: string }> = [];
let captureByTarget = new Map<string, string | Error>();
let resolveCalls: string[] = [];
let detectCalls: string[] = [];
let findWorktreeCalls: Array<{ parentDir: string; repoName: string }> = [];
let captureCalls: Array<{ target: string; lines: number }> = [];
let logs: string[] = [];

const originalLog = console.log;

function loadTestFleetEntries() {
  return readdirSync(TEST_FLEET_DIR)
    .filter(file => file.endsWith(".json") && !file.endsWith(".disabled"))
    .sort()
    .map(file => {
      const match = file.match(/^(\d+)-(.+)\.json$/);
      return {
        file,
        path: join(TEST_FLEET_DIR, file),
        num: match ? Number.parseInt(match[1], 10) : 0,
        groupName: match ? match[2] : file.replace(/\.json$/, ""),
        session: JSON.parse(readFileSync(join(TEST_FLEET_DIR, file), "utf-8") || "{}"),
      };
    });
}

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  FLEET_DIR: TEST_FLEET_DIR,
  listSessions: async () => sessions,
  capture: async (target: string, lines: number) => {
    captureCalls.push({ target, lines });
    const value = captureByTarget.get(target);
    if (value instanceof Error) throw value;
    return value ?? "";
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake"), () => ({
  detectSession: async (name: string) => {
    detectCalls.push(name);
    return detectedSession;
  },
  findWorktrees: async (parentDir: string, repoName: string) => {
    findWorktreeCalls.push({ parentDir, repoName });
    return worktrees;
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: loadTestFleetEntries,
}));

mock.module(import.meta.resolve("../../src/commands/plugins/oracle/impl-helpers"), () => ({
  resolveOracleSafe: async (name: string) => {
    resolveCalls.push(name);
    return resolveResult;
  },
}));

const { cmdOracleAbout } = await import("../../src/commands/plugins/oracle/impl-about.ts?oracle-impl-about-coverage");

function output() {
  return logs.join("\n");
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function writeFleet(file: string, windows: Array<{ name: string }>) {
  writeFileSync(join(TEST_FLEET_DIR, file), JSON.stringify({ windows }, null, 2), "utf-8");
}

beforeEach(() => {
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
  mkdirSync(TEST_FLEET_DIR, { recursive: true });
  sessions = [];
  detectedSession = null;
  resolveResult = { repoPath: null, repoName: "", parentDir: null };
  worktrees = [];
  captureByTarget = new Map();
  resolveCalls = [];
  detectCalls = [];
  findWorktreeCalls = [];
  captureCalls = [];
  logs = [];
  console.log = (line?: unknown) => {
    logs.push(String(line ?? ""));
  };
});

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
});

describe("oracle about impl isolated coverage", () => {
  test("rejects unknown oracle when repo, session, and fleet signals are all absent", async () => {
    await expect(cmdOracleAbout("GhostCase")).rejects.toThrow("no oracle named 'GhostCase' — try: maw oracle ls");

    expect(resolveCalls).toEqual(["ghostcase"]);
    expect(detectCalls).toEqual(["ghostcase"]);
    expect(output()).toBe("");
  });

  test("renders repo, session window statuses, worktrees, fleet counts, and unregistered warnings", async () => {
    resolveResult = {
      repoPath: "/repo/mawjs",
      repoName: "mawjs",
      parentDir: "/repo",
    };
    detectedSession = "mawjs-live";
    sessions = [
      {
        name: "mawjs-live",
        windows: [
          { index: 0, name: "mawjs-oracle" },
          { index: 1, name: "scratch" },
          { index: 2, name: "stale" },
        ],
      },
    ];
    worktrees = [
      { name: "alpha", path: "/repo/mawjs" },
      { name: "fix", path: "/repo/mawjs-fix" },
    ];
    captureByTarget.set("mawjs-live:0", "ready\n");
    captureByTarget.set("mawjs-live:1", "   ");
    captureByTarget.set("mawjs-live:2", new Error("pane missing"));
    writeFleet("mawjs.json", [{ name: "mawjs-oracle" }, { name: "registered-only" }]);

    await cmdOracleAbout("mawjs");

    const plain = stripAnsi(output());
    expect(plain).toContain("Oracle — mawjs");
    expect(plain).toContain("Repo:      /repo/mawjs");
    expect(plain).toContain("Session:   mawjs-live (3 windows)");
    expect(plain).toContain("● mawjs-oracle");
    expect(plain).toContain("● scratch");
    expect(plain).toContain("○ stale");
    expect(plain).toContain("Worktrees: 2");
    expect(plain).toContain("alpha → /repo/mawjs");
    expect(plain).toContain("fix → /repo/mawjs-fix");
    expect(plain).toContain("Fleet:     mawjs.json (2 registered, 3 running)");
    expect(plain).toContain("2 window(s) not in fleet config");
    expect(plain).toContain("→ scratch");
    expect(plain).toContain("→ stale");
    expect(plain).toContain("Fix: add to fleet/mawjs.json");
    expect(findWorktreeCalls).toEqual([{ parentDir: "/repo", repoName: "mawjs" }]);
    expect(captureCalls).toEqual([
      { target: "mawjs-live:0", lines: 3 },
      { target: "mawjs-live:1", lines: 3 },
      { target: "mawjs-live:2", lines: 3 },
    ]);
  });

  test("uses fleet membership as a valid oracle signal even without repo or session", async () => {
    writeFleet("remote.json", [{ name: "Remote-oracle" }]);

    await cmdOracleAbout("Remote");

    const plain = stripAnsi(output());
    expect(plain).toContain("Oracle — Remote");
    expect(plain).toContain("Repo:      (not found)");
    expect(plain).toContain("Session:   (none)");
    expect(plain).toContain("Fleet:     remote.json (1 registered, 0 running)");
    expect(findWorktreeCalls).toEqual([]);
    expect(captureCalls).toEqual([]);
  });
});
