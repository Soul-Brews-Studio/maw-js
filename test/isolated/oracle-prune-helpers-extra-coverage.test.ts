/** Focused isolated coverage for oracle impl-prune.ts and impl-helpers.ts. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OracleEntry } from "../../src/sdk";
import type { StaleEntry } from "../../src/commands/plugins/oracle/impl-stale";

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-prune-config-"));
const TEST_FLEET_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-prune-fleet-"));

type Session = { name: string; windows: Array<{ index?: number; name: string }> };

let sessions: Session[] = [];
let listSessionsError: Error | null = null;
let ghqCalls: string[] = [];
let ghqResults = new Map<string, string | null>();
let logs: string[] = [];

const originalLog = console.log;
const originalDateNow = Date.now;

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
  CONFIG_DIR: TEST_CONFIG_DIR,
  FLEET_DIR: TEST_FLEET_DIR,
  listSessions: async () => {
    if (listSessionsError) throw listSessionsError;
    return sessions;
  },
  readCache: () => ({ oracles: [] }),
  scanAndCache: () => ({ oracles: [] }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: loadTestFleetEntries,
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async (pattern: string) => {
    ghqCalls.push(pattern);
    return ghqResults.get(pattern) ?? null;
  },
}));

const prune = await import("../../src/commands/plugins/oracle/impl-prune.ts?oracle-prune-helpers-extra-coverage");
const helpers = await import("../../src/commands/plugins/oracle/impl-helpers.ts?oracle-prune-helpers-extra-coverage");

function entry(patch: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: "ghost-oracle",
    name: "ghost",
    local_path: "/repos/ghost-oracle",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

function stale(name: string, patch: Partial<StaleEntry> = {}): StaleEntry {
  return {
    name,
    org: "Soul-Brews-Studio",
    repo: `${name}-oracle`,
    local_path: `/repos/${name}-oracle`,
    has_psi: false,
    awake: false,
    last_commit: null,
    days_since_commit: null,
    tier: "STALE",
    recommendation: "investigate",
    ...patch,
  };
}

function captureConsole() {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
}

function output() {
  return logs.join("\n");
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
  mkdirSync(TEST_FLEET_DIR, { recursive: true });
  sessions = [];
  listSessionsError = null;
  ghqCalls = [];
  ghqResults = new Map();
  Date.now = originalDateNow;
  captureConsole();
});

afterEach(() => {
  console.log = originalLog;
  Date.now = originalDateNow;
});

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
});

describe("oracle prune extra isolated coverage", () => {
  test("default awake discovery treats tmux failures as no awake sessions", async () => {
    listSessionsError = new Error("tmux unavailable");

    const candidates = await prune.runPrune({}, {
      readRawCache: () => ({ oracles: [entry({ name: "fallback" })] }),
      writeRawCache: () => { throw new Error("dry run must not write"); },
    });

    expect(candidates.map((candidate) => candidate.entry.name)).toEqual(["fallback"]);
    expect(candidates[0].reasons).toEqual(["empty lineage", "no tmux", "no federation"]);
  });

  test("json output reports schema, count, dry_run, and candidates without mutating cache", async () => {
    let wrote = false;

    await prune.cmdOraclePrune({ json: true }, {
      listAwake: async () => new Set(),
      readRawCache: () => ({ oracles: [entry({ name: "json-ghost", local_path: "" })] }),
      writeRawCache: () => { wrote = true; },
    });

    const payload = JSON.parse(output());
    expect(payload).toMatchObject({ schema: 1, count: 1, dry_run: true });
    expect(payload.candidates[0].entry.name).toBe("json-ghost");
    expect(payload.candidates[0].reasons).toContain("not cloned");
    expect(wrote).toBe(false);
  });

  test("human output distinguishes clean, dry-run, abort, and force retirement paths", async () => {
    await prune.cmdOraclePrune({}, {
      listAwake: async () => new Set(["healthy"]),
      readRawCache: () => ({ oracles: [entry({ name: "healthy", has_psi: true })] }),
    });
    expect(stripAnsi(output())).toContain("No prune candidates");

    logs = [];
    await prune.cmdOraclePrune({ stale: true }, {
      runStale: async () => [
        stale("dusty", { tier: "STALE", awake: true, recommendation: "inspect" }),
        stale("deadwood", { tier: "DEAD", recommendation: "prune candidate" }),
      ],
      readRawCache: () => ({ oracles: [] }),
    });
    const dryRunOutput = stripAnsi(output());
    expect(dryRunOutput).toContain("Prune candidates (2)");
    expect(dryRunOutput).toContain("dry-run");
    expect(dryRunOutput).toContain("dusty");
    expect(dryRunOutput).not.toContain("dusty                         STALE (30-90d), inspect, no tmux");
    expect(dryRunOutput).toContain("deadwood");
    expect(dryRunOutput).toContain("Run with --force");

    logs = [];
    let wrote = false;
    await prune.cmdOraclePrune({ force: true }, {
      listAwake: async () => new Set(),
      promptConfirm: async () => false,
      readRawCache: () => ({ oracles: [entry({ name: "abort-me" })] }),
      writeRawCache: () => { wrote = true; },
    });
    expect(stripAnsi(output())).toContain("Aborted.");
    expect(wrote).toBe(false);

    logs = [];
    let written: Record<string, unknown> | null = null;
    await prune.cmdOraclePrune({ force: true }, {
      listAwake: async () => new Set(),
      promptConfirm: async (message) => message.includes("Retire 1 oracle"),
      readRawCache: () => ({
        oracles: [entry({ name: "retire-me" }), entry({ name: "keep-me", has_psi: true })],
        retired: [entry({ name: "already-retired" })],
      }),
      writeRawCache: (data) => { written = data; },
    });

    expect((written!.oracles as OracleEntry[]).map((oracle) => oracle.name)).toEqual(["keep-me"]);
    const retired = written!.retired as Array<OracleEntry & { retired_at?: string; retired_reasons?: string[] }>;
    expect(retired.map((oracle) => oracle.name)).toEqual(["already-retired", "retire-me"]);
    expect(retired[1].retired_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(retired[1].retired_reasons).toContain("empty lineage");
    expect(stripAnsi(output())).toContain("Retired 1 oracle(s) → retired[] in registry");
  });

  test("stale candidates preserve entry defaults and only add no-tmux reason when not awake", () => {
    const candidates = prune.buildStaleCandidates([
      stale("awake-stale", { awake: true, tier: "STALE", recommendation: "inspect awake" }),
      stale("sleeping-dead", { awake: false, tier: "DEAD", recommendation: "retire" }),
      stale("active", { tier: "ACTIVE" as StaleEntry["tier"] }),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      tier: "STALE",
      entry: { name: "awake-stale", has_fleet_config: false, budded_from: null, federation_node: null, detected_at: "" },
      reasons: ["STALE (30-90d)", "inspect awake"],
    });
    expect(candidates[1].reasons).toEqual(["DEAD (>90d)", "retire", "no tmux"]);
  });
});

describe("oracle helper extra isolated coverage", () => {
  test("resolveOracleSafe prefers -oracle repos, falls back to exact repo names, and reports misses", async () => {
    ghqResults.set("/neo-oracle$", "/ghq/Soul-Brews-Studio/neo-oracle");
    await expect(helpers.resolveOracleSafe("neo")).resolves.toEqual({
      repoPath: "/ghq/Soul-Brews-Studio/neo-oracle",
      repoName: "neo-oracle",
      parentDir: "/ghq/Soul-Brews-Studio",
    });
    expect(ghqCalls).toEqual(["/neo-oracle$"]);

    ghqCalls = [];
    ghqResults = new Map([["/homekeeper$", "/ghq/Soul-Brews-Studio/homekeeper"]]);
    await expect(helpers.resolveOracleSafe("homekeeper")).resolves.toEqual({
      repoPath: "/ghq/Soul-Brews-Studio/homekeeper",
      repoName: "homekeeper",
      parentDir: "/ghq/Soul-Brews-Studio",
    });
    expect(ghqCalls).toEqual(["/homekeeper-oracle$", "/homekeeper$"]);

    ghqCalls = [];
    ghqResults = new Map();
    await expect(helpers.resolveOracleSafe("missing")).resolves.toEqual({ parentDir: "", repoName: "", repoPath: "" });
    expect(ghqCalls).toEqual(["/missing-oracle$", "/missing$"]);
  });

  test("discoverOracles merges valid fleet configs with tmux, skips disabled files, and tolerates bad sources", async () => {
    writeFileSync(join(TEST_FLEET_DIR, "zeta.json"), JSON.stringify({ windows: [{ name: "zeta-oracle" }, { name: "notes" }] }), "utf-8");
    writeFileSync(join(TEST_FLEET_DIR, "alpha.json"), JSON.stringify({ windows: [{ name: "alpha-oracle" }] }), "utf-8");
    writeFileSync(join(TEST_FLEET_DIR, "ignored.json.disabled"), JSON.stringify({ windows: [{ name: "ignored-oracle" }] }), "utf-8");
    sessions = [
      { name: "session-one", windows: [{ name: "beta-oracle" }, { name: "plain" }] },
      { name: "session-two", windows: [{ name: "alpha-oracle" }] },
    ];

    await expect(helpers.discoverOracles()).resolves.toEqual(["alpha", "beta", "zeta"]);

    rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
    listSessionsError = new Error("tmux offline");
    await expect(helpers.discoverOracles()).resolves.toEqual([]);
  });

  test("lineageOf prefers agents federation provenance and timeSince covers every age bucket", () => {
    expect(helpers.lineageOf(
      entry({ name: "agent-backed", has_fleet_config: true, has_psi: true, federation_node: "entry-node" }),
      true,
      { "agent-backed": "agent-node" },
    )).toEqual({
      hasFleetConfig: true,
      hasPsi: true,
      isAwake: true,
      inAgents: true,
      federationNode: "agent-node",
    });

    expect(helpers.lineageOf(
      entry({ name: "entry-backed", federation_node: "entry-node" }),
      false,
      {},
    )).toEqual({
      hasFleetConfig: false,
      hasPsi: false,
      isAwake: false,
      inAgents: false,
      federationNode: "entry-node",
    });

    expect(helpers.lineageOf(entry({ name: "local-only", federation_node: null }), false, {})).toEqual({
      hasFleetConfig: false,
      hasPsi: false,
      isAwake: false,
      inAgents: false,
      federationNode: undefined,
    });

    Date.now = () => new Date("2026-05-18T12:00:00.000Z").getTime();
    expect(helpers.timeSince("2026-05-18T11:59:45.000Z")).toBe("15s");
    expect(helpers.timeSince("2026-05-18T11:10:00.000Z")).toBe("50m");
    expect(helpers.timeSince("2026-05-18T02:00:00.000Z")).toBe("10h");
    expect(helpers.timeSince("2026-05-16T00:00:00.000Z")).toBe("2d");
  });
});
