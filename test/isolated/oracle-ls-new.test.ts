/**
 * oracle-ls-new.test.ts — end-to-end coverage for `maw oracle ls --new` (#1273).
 *
 * Lives in test/isolated/ because it mutates `MAW_CONFIG_DIR` BEFORE importing
 * the target. Same sandboxing pattern as oracle-ls-manifest.test.ts: pin
 * CONFIG_DIR + FLEET_DIR, mock the tmux barrel, then dynamic-import.
 *
 * Unit-level tests (parseDuration, cascade priority, preprocessNewFlag) live
 * in test/plugins/oracle/ls-new.test.ts — they don't need filesystem sandboxing.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Pin CONFIG_DIR + FLEET_DIR to a sandboxed tmp dir BEFORE imports ───────
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-oracle-ls-new-e2e-1273-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
mkdirSync(TEST_FLEET_DIR, { recursive: true });

process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
delete process.env.MAW_HOME;
process.env.MAW_TEST_MODE = "1";

// Mock tmux barrel — listSessions() must not spawn real tmux.
let tmuxSessions: Array<{ name: string; windows: Array<{ index: number; name: string; active: boolean }> }> = [];
mock.module("../../src/core/transport/tmux", () => {
  const impl = {
    async listAll() { return tmuxSessions; },
    async listSessions() { return tmuxSessions; },
    async hasSession(name: string) { return tmuxSessions.some((s) => s.name === name); },
  };
  return {
    tmux: impl,
    Tmux: class { async listAll() { return tmuxSessions; } async listSessions() { return tmuxSessions; } async hasSession(n: string) { return tmuxSessions.some((s) => s.name === n); } },
    tmuxCmd: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    resolveSocket: () => undefined,
    withPaneLock: async (_id: string, fn: () => any) => fn(),
    splitWindowLocked: async () => "",
    tagPane: async () => {},
    readPaneTags: async () => ({}),
  };
});

const impl = await import("../../src/commands/plugins/oracle/impl-list");
const helpers = await import("../../src/commands/plugins/oracle/impl-helpers");
const config = await import("../../src/config");
const manifest = await import("../../src/lib/oracle-manifest");

const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");
const BIRTHS_JSON = join(TEST_CONFIG_DIR, "oracle-births.json");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [CONFIG_FILE, ORACLES_JSON, BIRTHS_JSON]) {
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

function writeOraclesJson(oracles: any[]) {
  writeFileSync(
    ORACLES_JSON,
    JSON.stringify(
      {
        schema: 1,
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

function makeEntry(over: Partial<any> = {}): any {
  return {
    org: "Soul-Brews-Studio",
    repo: `${over.name ?? "alpha"}-oracle`,
    name: over.name ?? "alpha",
    local_path: `/tmp/${over.name ?? "alpha"}-oracle`,
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date().toISOString(),
    ...over,
  };
}

async function runLsJson(opts: Parameters<typeof impl.cmdOracleList>[0] = {}): Promise<any> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await impl.cmdOracleList({ ...opts, json: true, stale: true });
  } finally {
    console.log = orig;
  }
  return JSON.parse(lines.join("\n"));
}

async function runLs(opts: Parameters<typeof impl.cmdOracleList>[0] = {}): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await impl.cmdOracleList({ ...opts, stale: true });
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("cmdOracleList — --new filter (#1273)", () => {
  test("--new=24h keeps only entries within window, sorts newest first", async () => {
    const now = Date.now();
    const minus2h = new Date(now - 2 * 3600_000).toISOString();
    const minus20h = new Date(now - 20 * 3600_000).toISOString();
    const minus3d = new Date(now - 3 * 86400_000).toISOString();

    writeOraclesJson([
      makeEntry({ name: "fresh", budded_at: minus2h }),
      makeEntry({ name: "edge", budded_at: minus20h }),
      makeEntry({ name: "stale", budded_at: minus3d }),
    ]);

    const result = await runLsJson({ new: "24h" });
    const names = result.oracles.map((o: any) => o.name);
    expect(names).toEqual(["fresh", "edge"]); // sorted newest first
    expect(result.oracles[0].created_source).toBe("budded_at");
  });

  test("--since=DATE filters by absolute lower bound", async () => {
    writeOraclesJson([
      makeEntry({ name: "ancient", budded_at: "2025-01-01T00:00:00.000Z" }),
      makeEntry({ name: "recent", budded_at: "2026-05-10T00:00:00.000Z" }),
      makeEntry({ name: "newest", budded_at: "2026-05-12T00:00:00.000Z" }),
    ]);
    const result = await runLsJson({ since: "2026-05-01" });
    const names = result.oracles.map((o: any) => o.name);
    expect(names).toEqual(["newest", "recent"]);
  });

  test("invalid --new duration throws UserError", async () => {
    writeOraclesJson([makeEntry({ name: "x" })]);
    await expect(runLsJson({ new: "garbage" })).rejects.toThrow(/invalid duration/);
  });

  test("invalid --since date throws UserError", async () => {
    writeOraclesJson([makeEntry({ name: "x" })]);
    await expect(runLsJson({ since: "not-a-date" })).rejects.toThrow(/invalid date/);
  });

  test("empty result prints friendly hint (non-JSON)", async () => {
    writeOraclesJson([
      makeEntry({ name: "old", budded_at: "2020-01-01T00:00:00.000Z" }),
    ]);
    const out = await runLs({ new: "7d" });
    expect(out).toContain("No oracles created in the last 7d");
    expect(out).toContain("Try --new=30d");
  });

  test("JSON output adds created_at + created_source per entry", async () => {
    writeOraclesJson([
      makeEntry({ name: "k", budded_at: new Date().toISOString() }),
    ]);
    const result = await runLsJson({ new: "1d" });
    expect(result.oracles).toHaveLength(1);
    expect(result.oracles[0].created_at).toBeDefined();
    expect(result.oracles[0].created_source).toBe("budded_at");
  });

  test("git tier feeds JSON when budded_at is missing", async () => {
    const fixedIso = "2026-05-11T08:00:00.000Z";
    writeOraclesJson([
      makeEntry({ name: "hand", budded_at: null, local_path: "/tmp/hand-oracle" }),
    ]);
    const result = await runLsJson({
      new: "10y".replace("y", "w") === "10w" ? "10w" : "10w", // 10 weeks, comfortably wide
      _resolveDeps: {
        gitFirstCommitDate: async () => fixedIso,
        fleetConfigBirthtime: () => null,
        claudeMdBirthtime: () => null,
      },
    });
    expect(result.oracles).toHaveLength(1);
    expect(result.oracles[0].created_source).toBe("git-claudemd");
    expect(result.oracles[0].created_at).toBe(fixedIso);
  });

  test("composes with --org filter", async () => {
    writeOraclesJson([
      makeEntry({ name: "a", org: "alpha-org", budded_at: new Date().toISOString() }),
      makeEntry({ name: "b", org: "beta-org", budded_at: new Date().toISOString() }),
    ]);
    const result = await runLsJson({ new: "7d", org: "alpha-org" });
    expect(result.oracles).toHaveLength(1);
    expect(result.oracles[0].name).toBe("a");
  });
});

describe("oracle-births.json cache (filesystem-backed, #1273)", () => {
  test("write then read round-trips", () => {
    const c: helpers.OracleBirthsCache = {
      version: 1,
      entries: {
        foo: { iso: "2026-05-10T00:00:00.000Z", source: "git-claudemd", cached_at: new Date().toISOString() },
      },
    };
    helpers.writeBirthsCache(c);
    expect(existsSync(BIRTHS_JSON)).toBe(true);
    const back = helpers.readBirthsCache();
    expect(back.entries.foo).toBeDefined();
    expect(back.entries.foo.source).toBe("git-claudemd");
  });

  test("invalidates when oracles.json is newer", () => {
    helpers.writeBirthsCache({
      version: 1,
      entries: {
        foo: { iso: "2026-05-10T00:00:00.000Z", source: "git-claudemd", cached_at: new Date().toISOString() },
      },
    });
    expect(helpers.readBirthsCache().entries.foo).toBeDefined();

    writeOraclesJson([]);
    // Force oracles.json mtime to "later" — defeats sub-second fs granularity.
    const future = (Date.now() + 5_000) / 1000;
    utimesSync(ORACLES_JSON, future, future);

    const after = helpers.readBirthsCache();
    expect(Object.keys(after.entries)).toHaveLength(0);
  });
});
