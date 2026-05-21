/** Focused function coverage for src/commands/plugins/oracle/impl-prune.ts. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough, Writable } from "stream";
import type { OracleEntry } from "../../src/sdk";
import type { StaleEntry, StaleTier } from "../../src/commands/plugins/oracle/impl-stale";

type Session = { name: string; windows: Array<{ index?: number; name: string }> };

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-impl-prune-fnf-"));
const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-impl-prune-fnf-cache-"));
const REGISTRY_FILE = join(TEST_CACHE_DIR, "oracles.json");
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalCacheDir = process.env.MAW_CACHE_DIR;
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_CACHE_DIR = TEST_CACHE_DIR;

let sessions: Session[] | Error = [];
let logs: string[] = [];

const originalLog = console.log;

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  CONFIG_DIR: TEST_CONFIG_DIR,
  listSessions: async () => {
    if (sessions instanceof Error) throw sessions;
    return sessions;
  },
  readCache: () => ({ oracles: [] }),
  scanAndCache: () => ({ oracles: [] }),
}));

const prune = await import("../../src/commands/plugins/oracle/impl-prune");

function entry(patch: Partial<OracleEntry> = {}): OracleEntry {
  const name = patch.name ?? "ghost";
  return {
    org: "Soul-Brews-Studio",
    repo: `${name}-oracle`,
    name,
    local_path: join(TEST_CONFIG_DIR, `${name}-oracle`),
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

function stale(name: string, tier: StaleTier, patch: Partial<StaleEntry> = {}): StaleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: `${name}-oracle`,
    name,
    local_path: join(TEST_CONFIG_DIR, `${name}-oracle`),
    has_psi: false,
    awake: false,
    last_commit: null,
    days_since_commit: null,
    tier,
    recommendation: tier === "DEAD" ? "retire" : "inspect",
    ...patch,
  };
}

function writeRegistry(raw: Record<string, unknown> | string): void {
  writeFileSync(REGISTRY_FILE, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2), "utf-8");
}

function readRegistry(): Record<string, unknown> {
  return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
}

function captureLogs(): void {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
}

function output(): string {
  return logs.join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function runWithPrompt(answer: string, fn: () => Promise<unknown>): Promise<{ prompt: string; logs: string }> {
  const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process, "stdout");
  const input = new PassThrough();
  const promptChunks: string[] = [];
  const outputChunks: string[] = [];
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      promptChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    },
  });

  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: outputStream, configurable: true });
  console.log = (...args: unknown[]) => {
    outputChunks.push(args.map(String).join(" "));
  };

  input.end(`${answer}\n`);
  try {
    await fn();
  } finally {
    console.log = originalLog;
    if (stdinDesc) Object.defineProperty(process, "stdin", stdinDesc);
    if (stdoutDesc) Object.defineProperty(process, "stdout", stdoutDesc);
  }

  return { prompt: promptChunks.join(""), logs: outputChunks.join("\n") };
}

beforeEach(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  sessions = [];
  captureLogs();
});

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalCacheDir === undefined) delete process.env.MAW_CACHE_DIR;
  else process.env.MAW_CACHE_DIR = originalCacheDir;
});

describe("oracle impl-prune function coverage", () => {
  test("pure helpers cover raw registry, awake, regular candidates, and stale candidates", async () => {
    writeRegistry("{ invalid");
    expect(prune.readRawRegistry(REGISTRY_FILE)).toEqual({});

    prune.writeRawRegistry(REGISTRY_FILE, { oracles: [entry({ name: "written" })] });
    expect(readRegistry()).toMatchObject({ oracles: [{ name: "written" }] });

    const candidates = prune.buildPruneCandidates([
      entry({ name: "candidate", local_path: "" }),
      entry({ name: "awake" }),
      entry({ name: "federated", federation_node: "white" }),
      entry({ name: "lineage", has_psi: true }),
    ], new Set(["awake"]));
    expect(candidates.map((candidate) => candidate.entry.name)).toEqual(["candidate"]);
    expect(candidates[0].reasons).toEqual(["empty lineage", "not cloned", "no tmux", "no federation"]);

    const staleCandidates = prune.buildStaleCandidates([
      stale("active", "ACTIVE", { awake: true }),
      stale("stale-silent", "STALE"),
      stale("dead-awake", "DEAD", { awake: true }),
    ]);
    expect(staleCandidates.map((candidate) => candidate.entry.name)).toEqual(["stale-silent", "dead-awake"]);
    expect(staleCandidates[0]).toMatchObject({ tier: "STALE", reasons: ["STALE (30-90d)", "inspect", "no tmux"] });
    expect(staleCandidates[1]).toMatchObject({ tier: "DEAD", reasons: ["DEAD (>90d)", "retire"] });

    sessions = [{ name: "ops", windows: [{ name: "awake-oracle" }, { name: "notes" }] }];
    await expect(prune.listAwakeOracles()).resolves.toEqual(new Set(["awake"]));

    sessions = new Error("tmux unavailable");
    await expect(prune.listAwakeOracles()).resolves.toEqual(new Set());
  });

  test("runPrune uses default raw cache, default awake discovery, and stale dependency threading", async () => {
    writeRegistry({
      oracles: [
        entry({ name: "default-candidate", local_path: "" }),
        entry({ name: "default-awake" }),
      ],
    });
    sessions = [{ name: "live", windows: [{ name: "default-awake-oracle" }] }];

    const regular = await prune.runPrune();
    expect(regular.map((candidate) => candidate.entry.name)).toEqual(["default-candidate"]);

    const sourceEntries = [entry({ name: "threaded" })];
    const now = new Date("2026-05-18T12:00:00.000Z");
    const calls: string[] = [];
    const staleCandidates = await prune.runPrune({ stale: true }, {
      readEntries: () => {
        calls.push("readEntries");
        return sourceEntries;
      },
      listAwake: async () => {
        calls.push("listAwake");
        return new Set(["threaded"]);
      },
      now: () => {
        calls.push("now");
        return now;
      },
      runStale: async (opts, deps) => {
        expect(opts).toEqual({ all: false });
        expect(deps.readEntries?.()).toEqual(sourceEntries);
        expect(await deps.listAwake?.()).toEqual(new Set(["threaded"]));
        expect(deps.now?.()).toBe(now);
        return [stale("threaded", "DEAD", { awake: true })];
      },
    });

    expect(calls).toEqual(["readEntries", "listAwake", "now"]);
    expect(staleCandidates).toMatchObject([{ tier: "DEAD", entry: { name: "threaded" } }]);
  });

  test("cmdOraclePrune uses default cache I/O for json, dry-run, and default prompt retirement", async () => {
    writeRegistry({ oracles: [entry({ name: "json-candidate", local_path: "" })] });
    await prune.cmdOraclePrune({ json: true });

    const json = JSON.parse(output());
    expect(json).toMatchObject({ schema: 1, count: 1, dry_run: true });
    expect(json.candidates[0].entry.name).toBe("json-candidate");

    captureLogs();
    writeRegistry({ oracles: [entry({ name: "dry-candidate", local_path: "" })] });
    await prune.cmdOraclePrune();
    const dryRun = stripAnsi(output());
    expect(dryRun).toContain("Prune candidates (1)");
    expect(dryRun).toContain("Run with --force");
    expect((readRegistry().oracles as OracleEntry[]).map((oracle) => oracle.name)).toEqual(["dry-candidate"]);

    captureLogs();
    writeRegistry({ oracles: [entry({ name: "awake-clean" })] });
    sessions = [{ name: "live", windows: [{ name: "awake-clean-oracle" }] }];
    await prune.cmdOraclePrune();
    expect(stripAnsi(output())).toContain("No prune candidates");
    sessions = [];

    writeRegistry({
      oracles: [entry({ name: "prompt-candidate", local_path: "" })],
      retired: [entry({ name: "already-retired" })],
    });
    const accepted = await runWithPrompt("y", () => prune.cmdOraclePrune({ force: true }));
    expect(accepted.prompt).toContain("Retire 1 oracle(s)?");
    expect(stripAnsi(accepted.logs)).toContain("Retired 1 oracle(s) → retired[] in registry");
    expect((readRegistry().oracles as OracleEntry[])).toEqual([]);
    expect((readRegistry().retired as OracleEntry[]).map((oracle) => oracle.name)).toEqual(["already-retired", "prompt-candidate"]);

    writeRegistry({ oracles: [entry({ name: "declined-candidate", local_path: "" })] });
    const declined = await runWithPrompt("n", () => prune.cmdOraclePrune({ force: true }));
    expect(declined.prompt).toContain("Retire 1 oracle(s)?");
    expect(stripAnsi(declined.logs)).toContain("Aborted.");
    expect((readRegistry().oracles as OracleEntry[]).map((oracle) => oracle.name)).toEqual(["declined-candidate"]);
  });
});
