/**
 * oracle-manifest.test.ts — #836 (Sub-issue 2 of #736 Phase 2).
 *
 * Verifies the unified `OracleManifest` aggregator over the 5 oracle
 * registries:
 *   1. fleet windows         (FLEET_DIR/*.json)
 *   2. config.sessions       (Record<oracle, sessionId>)
 *   3. config.agents         (Record<oracle, node>)
 *   4. oracles-json cache    (CONFIG_DIR/oracles.json)
 *   5. worktree scan         (deferred — covered by mergeOraclesJsonEntry shape)
 *
 * Isolated (per-file subprocess) because we mutate process.env.MAW_CONFIG_DIR
 * BEFORE importing the target module. `src/core/paths.ts` captures CONFIG_DIR
 * at module-load time, and `src/config/load.ts` caches `loadConfig()`. Running
 * in the shared pool would leak fixture state across tests.
 */
import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Pin CONFIG_DIR + FLEET_DIR to a sandboxed tmp dir BEFORE imports ───────
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-manifest-836-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
mkdirSync(TEST_FLEET_DIR, { recursive: true });

process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
delete process.env.MAW_HOME;
// MAW_TEST_MODE prevents accidental writes to the real homedir if a test
// strays. Mirrors test/isolated/auth-secret-persist.test.ts hardening (#820).
process.env.MAW_TEST_MODE = "1";

// Import after env is set so module-load-time path capture lands on the tmp dir.
const manifest = await import("../../src/lib/oracle-manifest");
const config = await import("../../src/config");
const {
  loadManifest,
  findOracle,
  loadManifestCached,
  invalidateManifest,
  mergeOraclesJsonEntry,
  DEFAULT_TTL_MS,
} = manifest;

const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe all 4 file-backed registries between tests (the 5th — config.agents
  // pre-population — is recomputed on every loadConfig() call).
  for (const f of [CONFIG_FILE, ORACLES_JSON]) {
    try { rmSync(f, { force: true }); } catch { /* missing is fine */ }
  }
  // Wipe fleet dir.
  try {
    rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
    mkdirSync(TEST_FLEET_DIR, { recursive: true });
  } catch { /* best-effort */ }
  // Reset cached config + manifest TTL cache.
  config.resetConfig();
  invalidateManifest();
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

function makeOraclesEntry(o: Partial<any> & { name: string }) {
  return {
    org: "Soul-Brews-Studio",
    repo: `${o.name}-oracle`,
    name: o.name,
    local_path: `/home/nat/Code/github.com/Soul-Brews-Studio/${o.name}-oracle`,
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date().toISOString(),
    ...o,
  };
}

// ─── Aggregation across 5 sources ────────────────────────────────────────────

describe("loadManifest — aggregates from all sources", () => {
  test("empty everywhere → empty manifest", () => {
    expect(loadManifest()).toEqual([]);
  });

  test("fleet-only: surfaces oracle with session/window/repo + node=local", () => {
    writeFleetWindow("100-volt.json", "volt", [{ name: "volt-oracle", repo: "Soul-Brews-Studio/volt-oracle" }]);
    const m = loadManifest();
    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.name).toBe("volt");
    expect(e.session).toBe("volt");
    expect(e.window).toBe("volt-oracle");
    expect(e.repo).toBe("Soul-Brews-Studio/volt-oracle");
    expect(e.node).toBe("local");
    expect(e.hasFleetConfig).toBe(true);
    expect(e.sources).toContain("fleet");
    // fleet pre-populates config.agents at loadConfig time → also "agent".
    expect(e.sources).toContain("agent");
  });

  test("config.sessions-only: surfaces oracle with sessionId, no session/window", () => {
    writeConfig({ sessions: { neo: "uuid-aaa-bbb" } });
    const m = loadManifest();
    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.name).toBe("neo");
    expect(e.sessionId).toBe("uuid-aaa-bbb");
    expect(e.session).toBeUndefined();
    expect(e.window).toBeUndefined();
    expect(e.sources).toContain("session");
  });

  test("config.agents-only: surfaces oracle with node, no session/sessionId", () => {
    writeConfig({ agents: { homekeeper: "mba" } });
    const m = loadManifest();
    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.name).toBe("homekeeper");
    expect(e.node).toBe("mba");
    expect(e.sources).toContain("agent");
  });

  test("oracles-json-only: surfaces lineage + filesystem fields", () => {
    writeOraclesJson([
      makeOraclesEntry({
        name: "freshbud",
        budded_from: "neo",
        budded_at: "2026-04-01T00:00:00Z",
        has_psi: true,
        federation_node: "white",
      }),
    ]);
    const m = loadManifest();
    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.name).toBe("freshbud");
    expect(e.repo).toBe("Soul-Brews-Studio/freshbud-oracle");
    expect(e.localPath).toContain("freshbud-oracle");
    expect(e.buddedFrom).toBe("neo");
    expect(e.buddedAt).toBe("2026-04-01T00:00:00Z");
    expect(e.hasPsi).toBe(true);
    expect(e.node).toBe("white");
    expect(e.sources).toContain("oracles-json");
  });

  test("all 4 file-backed sources for the same oracle merge into one entry", () => {
    writeFleetWindow("110-omni.json", "omni-session", [
      { name: "omni-oracle", repo: "Soul-Brews-Studio/omni-oracle" },
    ]);
    writeConfig({
      sessions: { omni: "uuid-omni-1" },
      agents: { omni: "white" },
    });
    writeOraclesJson([
      makeOraclesEntry({
        name: "omni",
        budded_from: "neo",
        federation_node: "should-be-overridden",
      }),
    ]);

    const m = loadManifest();
    expect(m).toHaveLength(1);
    const e = m[0];

    expect(e.name).toBe("omni");
    expect(e.session).toBe("omni-session");
    expect(e.window).toBe("omni-oracle");
    expect(e.sessionId).toBe("uuid-omni-1");
    expect(e.buddedFrom).toBe("neo");
    expect(e.localPath).toContain("omni-oracle");

    // sources covers all 4 contributing registries
    for (const src of ["fleet", "session", "agent", "oracles-json"]) {
      expect(e.sources).toContain(src);
    }
  });
});

// ─── Merge precedence ────────────────────────────────────────────────────────

describe("loadManifest — merge precedence", () => {
  test("agent > fleet > oracles-json for `node`", () => {
    // fleet → implicit local, oracles-json → "old-node", agent → "white"
    writeFleetWindow("120-pri.json", "pri", [{ name: "pri-oracle" }]);
    writeConfig({ agents: { pri: "white" } });
    writeOraclesJson([makeOraclesEntry({ name: "pri", federation_node: "old-node" })]);
    expect(findOracle("pri")?.node).toBe("white");
  });

  test("fleet > oracles-json for `node` when no agent override", () => {
    writeFleetWindow("121-fall.json", "fall", [{ name: "fall-oracle" }]);
    writeOraclesJson([makeOraclesEntry({ name: "fall", federation_node: "white" })]);
    // fleet pre-populates config.agents with "local" via fleet-merge.ts —
    // so the agent-source value is what wins. Document the actual behavior.
    expect(findOracle("fall")?.node).toBe("local");
  });

  test("oracles-json `federation_node` only used when neither fleet nor agent set node", () => {
    writeOraclesJson([makeOraclesEntry({ name: "lone", federation_node: "phaith" })]);
    expect(findOracle("lone")?.node).toBe("phaith");
  });

  test("fleet wins for session/window/repo over oracles-json", () => {
    writeFleetWindow("130-mix.json", "mix-session", [
      { name: "mix-oracle", repo: "fleet-org/fleet-repo" },
    ]);
    writeOraclesJson([
      makeOraclesEntry({ name: "mix", org: "wrong-org", repo: "wrong-repo" }),
    ]);
    const e = findOracle("mix")!;
    expect(e.session).toBe("mix-session");
    expect(e.window).toBe("mix-oracle");
    expect(e.repo).toBe("fleet-org/fleet-repo");
  });

  test("multiple fleet files merged; later windows do NOT clobber earlier ones", () => {
    writeFleetWindow("141-a.json", "sess-a", [{ name: "shared-oracle", repo: "a/a" }]);
    writeFleetWindow("142-b.json", "sess-b", [{ name: "shared-oracle", repo: "b/b" }]);
    const e = findOracle("shared")!;
    // First-seen wins (sorted readdir → 141 before 142).
    expect(e.session).toBe("sess-a");
    expect(e.repo).toBe("a/a");
  });
});

// ─── findOracle ──────────────────────────────────────────────────────────────

describe("findOracle", () => {
  test("hits — returns matching entry", () => {
    writeFleetWindow("150-h.json", "hit", [{ name: "hit-oracle" }]);
    expect(findOracle("hit")?.name).toBe("hit");
  });

  test("misses — returns undefined", () => {
    writeFleetWindow("151-m.json", "miss", [{ name: "miss-oracle" }]);
    expect(findOracle("not-a-real-oracle")).toBeUndefined();
  });

  test("misses on the empty manifest", () => {
    expect(findOracle("anything")).toBeUndefined();
  });
});

// ─── TTL cache ───────────────────────────────────────────────────────────────

describe("loadManifestCached", () => {
  test("DEFAULT_TTL_MS exists and is positive", () => {
    expect(typeof DEFAULT_TTL_MS).toBe("number");
    expect(DEFAULT_TTL_MS).toBeGreaterThan(0);
  });

  test("two calls within TTL → second is cached (does not see new fleet entry)", () => {
    writeFleetWindow("160-cache-a.json", "first", [{ name: "first-oracle" }]);
    const first = loadManifestCached(60_000);
    expect(first.map((e) => e.name)).toEqual(["first"]);

    // Mutate the underlying state but stay inside TTL.
    writeFleetWindow("161-cache-b.json", "second", [{ name: "second-oracle" }]);
    config.resetConfig(); // ensure config-side mutations don't mask the cache test

    const second = loadManifestCached(60_000);
    // Cache returned the same array reference / contents — "second" is hidden.
    expect(second).toBe(first);
    expect(second.map((e) => e.name)).toEqual(["first"]);
  });

  test("ttlMs=0 → effectively disables cache (always reload)", () => {
    writeFleetWindow("162-ttl0-a.json", "a", [{ name: "a-oracle" }]);
    const first = loadManifestCached(0);
    writeFleetWindow("163-ttl0-b.json", "b", [{ name: "b-oracle" }]);
    config.resetConfig();
    const second = loadManifestCached(0);
    expect(first).not.toBe(second);
    expect(second.map((e) => e.name).sort()).toEqual(["a", "b"]);
  });

  test("invalidateManifest() forces a fresh reload on next call", () => {
    writeFleetWindow("170-inv-a.json", "x", [{ name: "x-oracle" }]);
    const first = loadManifestCached(60_000);
    expect(first.map((e) => e.name)).toEqual(["x"]);

    writeFleetWindow("171-inv-b.json", "y", [{ name: "y-oracle" }]);
    config.resetConfig();
    invalidateManifest();

    const second = loadManifestCached(60_000);
    expect(second).not.toBe(first);
    expect(second.map((e) => e.name).sort()).toEqual(["x", "y"]);
  });
});

// ─── Resilience ──────────────────────────────────────────────────────────────

describe("loadManifest — resilience to malformed sources", () => {
  test("malformed fleet json file is skipped, others still load", () => {
    writeFleetWindow("180-good.json", "good", [{ name: "good-oracle" }]);
    writeFileSync(join(TEST_FLEET_DIR, "181-broken.json"), "{ NOT JSON", "utf-8");
    const m = loadManifest();
    expect(m.map((e) => e.name)).toContain("good");
  });

  test("malformed oracles.json → empty contribution, fleet still surfaces", () => {
    writeFleetWindow("190-fl.json", "fl", [{ name: "fl-oracle" }]);
    writeFileSync(ORACLES_JSON, "{ broken", "utf-8");
    const m = loadManifest();
    expect(m.map((e) => e.name)).toEqual(["fl"]);
  });

  test("missing fleet dir entries → manifest still produces a config-only result", () => {
    // No fleet windows + only config.sessions/agents.
    writeConfig({ sessions: { only: "uuid-only" }, agents: { only: "mba" } });
    const e = findOracle("only")!;
    expect(e.sessionId).toBe("uuid-only");
    expect(e.node).toBe("mba");
  });
});

// ─── mergeOraclesJsonEntry — direct exposure for unit tests ──────────────────

describe("mergeOraclesJsonEntry — does not clobber pre-set fields", () => {
  test("preserves earlier-set repo, but fills in localPath + lineage", () => {
    const e = {
      name: "preset",
      sources: ["fleet"] as Array<typeof manifest extends never ? never : import("../../src/lib/oracle-manifest").OracleManifestSource>,
      isLive: false,
      repo: "fleet/preset",
    };
    mergeOraclesJsonEntry(e as any, makeOraclesEntry({
      name: "preset",
      org: "wrong",
      repo: "wrong",
      local_path: "/path/preset",
      budded_from: "neo",
    }) as any);
    // Repo NOT overwritten.
    expect((e as any).repo).toBe("fleet/preset");
    // localPath + buddedFrom filled.
    expect((e as any).localPath).toBe("/path/preset");
    expect((e as any).buddedFrom).toBe("neo");
    expect((e as any).sources).toContain("oracles-json");
  });
});
