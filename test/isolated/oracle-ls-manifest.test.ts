/**
 * oracle-ls-manifest.test.ts — sub-PR 1 of #841.
 *
 * Verifies that `maw oracle ls` (cmdOracleList) now sources its entries from
 * `OracleManifest` (#838) and therefore surfaces oracles that exist only in
 * non-`oracles.json` registries: fleet windows, config.sessions, config.agents.
 *
 * Pre-#841 behavior: ls iterated `cache.oracles` (oracles.json) only and
 * augmented with tmux-awake names. Anything that existed only in
 * `config.sessions` (just-budded, not yet filesystem-scanned) or only in fleet
 * windows (registered for routing but no local checkout) was invisible.
 *
 * Isolated subprocess because we mutate `process.env.MAW_CONFIG_DIR` BEFORE
 * importing the target module — `core/paths.ts` captures CONFIG_DIR at
 * module-load time. Mirrors the pattern from oracle-manifest.test.ts (#836).
 */
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Pin CONFIG_DIR + FLEET_DIR to a sandboxed tmp dir BEFORE imports ───────
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-ls-841-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
mkdirSync(TEST_FLEET_DIR, { recursive: true });

process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
delete process.env.MAW_HOME;
process.env.MAW_TEST_MODE = "1";

// Mock tmux barrel BEFORE importing the impl — so any code path that hits
// `listSessions()` returns our controlled value rather than spawning real tmux.
let tmuxSessions: Array<{ name: string; windows: Array<{ index: number; name: string; active: boolean }> }> = [];
mock.module("../../src/core/transport/tmux", () => {
  const impl = {
    async listAll() { return tmuxSessions; },
    async listSessions() { return tmuxSessions; },
    async hasSession(name: string) { return tmuxSessions.some(s => s.name === name); },
  };
  return {
    tmux: impl,
    Tmux: class { async listAll() { return tmuxSessions; } async listSessions() { return tmuxSessions; } async hasSession(n: string) { return tmuxSessions.some(s => s.name === n); } },
    tmuxCmd: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    resolveSocket: () => undefined,
    withPaneLock: async (_id: string, fn: () => any) => fn(),
    splitWindowLocked: async () => "",
    tagPane: async () => {},
    readPaneTags: async () => ({}),
  };
});

// Skip the oracles.json auto-rescan path — the impl calls scanAndCache("local")
// when the cache is missing/stale, which walks ghq root. We pre-write a fresh
// oracles.json in each test (so isCacheStale → false) AND pass `stale: true`
// to runLs so a stale read can't trigger a real filesystem walk either.

// Late import after env + mocks are set.
const impl = await import("../../src/commands/plugins/oracle/impl-list");
const config = await import("../../src/config");
const manifest = await import("../../src/lib/oracle-manifest");

const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [CONFIG_FILE, ORACLES_JSON]) {
    try { rmSync(f, { force: true }); } catch { /* ok */ }
  }
  try {
    rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
    mkdirSync(TEST_FLEET_DIR, { recursive: true });
  } catch { /* best-effort */ }
  config.resetConfig();
  manifest.invalidateManifest();
  tmuxSessions = [];
});

// ─── Fixture builders ────────────────────────────────────────────────────────

function writeFleetWindow(file: string, sessionName: string, windows: Array<{ name: string; repo?: string }>) {
  writeFileSync(
    join(TEST_FLEET_DIR, file),
    JSON.stringify({ name: sessionName, windows }, null, 2) + "\n",
    "utf-8",
  );
}

function writeConfig(patch: Record<string, unknown>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(patch, null, 2) + "\n", "utf-8");
  config.resetConfig();
}

function writeOraclesJson(oracles: any[]) {
  writeFileSync(
    ORACLES_JSON,
    JSON.stringify(
      {
        schema: 1,
        // Fresh timestamp so isCacheStale → false, no auto-rescan.
        local_scanned_at: new Date().toISOString(),
        ghq_root: "/tmp/ghq-fixture",
        oracles,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

// ─── stdout capture ──────────────────────────────────────────────────────────

async function runLs(opts: Parameters<typeof impl.cmdOracleList>[0] = {}): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await impl.cmdOracleList(opts);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

async function runLsJson(opts: Parameters<typeof impl.cmdOracleList>[0] = {}): Promise<any> {
  const out = await runLs({ ...opts, json: true, stale: true });
  return JSON.parse(out);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cmdOracleList — manifest-backed cross-source visibility (#841)", () => {
  test("oracles.json-only entry still appears (regression guard)", async () => {
    writeOraclesJson([
      {
        org: "Soul-Brews-Studio",
        repo: "alpha-fs-oracle",
        name: "alpha-fs",
        local_path: "/tmp/alpha-fs-oracle",
        has_psi: true,
        has_fleet_config: false,
        budded_from: null,
        budded_at: null,
        federation_node: null,
        detected_at: new Date().toISOString(),
      },
    ]);
    const result = await runLsJson();
    const names = result.oracles.map((o: any) => o.name);
    expect(names).toContain("alpha-fs");
  });

  test("fleet-only oracle (NOT in oracles.json) appears via manifest", async () => {
    // Empty oracles.json — fleet is the only registry that knows about
    // `fleet-only`. Pre-#841 this oracle was invisible to ls.
    writeOraclesJson([]);
    writeFleetWindow("100-fleet-only.json", "fleet-only-session", [
      { name: "fleet-only-oracle", repo: "Soul-Brews-Studio/fleet-only-oracle" },
    ]);

    const result = await runLsJson();
    const names = result.oracles.map((o: any) => o.name);
    expect(names).toContain("fleet-only");

    const entry = result.oracles.find((o: any) => o.name === "fleet-only");
    expect(entry).toBeDefined();
    expect(entry.org).toBe("Soul-Brews-Studio");
    expect(entry.repo).toBe("fleet-only-oracle");
    // Manifest sources should reflect fleet contribution.
    expect(entry.sources).toContain("fleet");
  });

  test("config.sessions-only oracle (just-budded) appears via manifest", async () => {
    // Empty oracles.json + no fleet — sessions is the only signal.
    writeOraclesJson([]);
    writeConfig({ sessions: { "just-budded": "uuid-jb-1" } });

    const result = await runLsJson();
    const names = result.oracles.map((o: any) => o.name);
    expect(names).toContain("just-budded");

    const entry = result.oracles.find((o: any) => o.name === "just-budded");
    expect(entry.sources).toContain("session");
  });

  test("config.agents-only oracle (federation-known, no local) appears via manifest", async () => {
    writeOraclesJson([]);
    writeConfig({ agents: { "remote-pal": "mba" } });

    const result = await runLsJson();
    const names = result.oracles.map((o: any) => o.name);
    expect(names).toContain("remote-pal");

    const entry = result.oracles.find((o: any) => o.name === "remote-pal");
    // federation_node should be derived from the agent map via manifest.
    expect(entry.federation_node).toBe("mba");
    expect(entry.sources).toContain("agent");
  });

  test("oracles.json + fleet entry merges into ONE row (no dupes)", async () => {
    writeOraclesJson([
      {
        org: "Soul-Brews-Studio",
        repo: "merged-oracle",
        name: "merged",
        local_path: "/tmp/merged-oracle",
        has_psi: true,
        has_fleet_config: true,
        budded_from: "neo",
        budded_at: "2026-04-01T00:00:00Z",
        federation_node: null,
        detected_at: new Date().toISOString(),
      },
    ]);
    writeFleetWindow("110-merged.json", "merged-session", [
      { name: "merged-oracle", repo: "Soul-Brews-Studio/merged-oracle" },
    ]);

    const result = await runLsJson();
    const matches = result.oracles.filter((o: any) => o.name === "merged");
    expect(matches).toHaveLength(1);
    const entry = matches[0];
    // local_path should still come from oracles.json (only registry with paths).
    expect(entry.local_path).toBe("/tmp/merged-oracle");
    // Source labels reflect both contributors.
    expect(entry.sources).toContain("fleet");
    expect(entry.sources).toContain("oracles-json");
  });

  test("totals reflect manifest union, not just oracles.json", async () => {
    writeOraclesJson([
      {
        org: "Soul-Brews-Studio",
        repo: "alpha-oracle",
        name: "alpha",
        local_path: "/tmp/alpha",
        has_psi: true,
        has_fleet_config: false,
        budded_from: null,
        budded_at: null,
        federation_node: null,
        detected_at: new Date().toISOString(),
      },
    ]);
    // Plus a fleet-only oracle the cache doesn't know about.
    writeFleetWindow("120-bravo.json", "bravo-session", [
      { name: "bravo-oracle", repo: "Soul-Brews-Studio/bravo-oracle" },
    ]);
    // Plus a sessions-only oracle.
    writeConfig({ sessions: { charlie: "uuid-c-1" } });

    const result = await runLsJson();
    expect(result.total).toBe(3);
    const names = result.oracles.map((o: any) => o.name).sort();
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
  });
});
