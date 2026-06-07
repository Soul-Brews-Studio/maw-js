/** Default dependency coverage for src/commands/plugins/oracle/impl-prune.ts. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OracleEntry } from "../../src/sdk";

const TEST_FLEET_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-impl-prune-defaults-fleet-"));
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-impl-prune-defaults-"));
const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-impl-prune-defaults-cache-"));
const REGISTRY_FILE = join(TEST_CACHE_DIR, "oracles.json");
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalCacheDir = process.env.MAW_CACHE_DIR;
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_CACHE_DIR = TEST_CACHE_DIR;

type Session = { name: string; windows: Array<{ index?: number; name: string }> };

let sessions: Session[] | Error = [];
let logs: string[] = [];

const originalLog = console.log;

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  CONFIG_DIR: TEST_CONFIG_DIR,
  FLEET_DIR: TEST_FLEET_DIR,
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

beforeEach(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
  sessions = [];
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterAll(() => {
  console.log = originalLog;
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalCacheDir === undefined) delete process.env.MAW_CACHE_DIR;
  else process.env.MAW_CACHE_DIR = originalCacheDir;
});

describe("oracle impl-prune default dependency coverage", () => {
  test("default awake discovery scans tmux oracle windows and ignores non-oracle windows", async () => {
    sessions = [{
      name: "maw",
      windows: [
        { index: 0, name: "awake-oracle" },
        { index: 1, name: "plain-shell" },
        { index: 2, name: "also-awake-oracle" },
      ],
    }];

    const candidates = await prune.runPrune({}, {
      readRawCache: () => ({
        oracles: [
          entry({ name: "awake" }),
          entry({ name: "also-awake" }),
          entry({ name: "ghost", local_path: "" }),
        ],
      }),
    });

    expect(candidates.map((candidate) => candidate.entry.name)).toEqual(["ghost"]);
    expect(candidates[0].reasons).toEqual(["empty lineage", "not cloned", "no tmux", "no federation"]);
  });

  test("force confirmation can use the default registry writer against the mocked config dir", async () => {
    writeFileSync(REGISTRY_FILE, JSON.stringify({ oracles: [entry({ name: "retire-me", local_path: "" })] }), "utf-8");

    await prune.cmdOraclePrune({ force: true }, {
      listAwake: async () => new Set<string>(),
      promptConfirm: async () => true,
    });

    const written = JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
    expect(written.oracles).toEqual([]);
    expect(written.retired.map((retired: OracleEntry) => retired.name)).toEqual(["retire-me"]);
    expect(logs.join("\n")).toContain("Retired 1 oracle(s) → retired[] in registry");
  });
});
