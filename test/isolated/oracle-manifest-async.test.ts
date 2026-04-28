/**
 * oracle-manifest-async.test.ts — Sub-PR 5 of #841.
 *
 * Verifies the async variant `loadManifestAsync()` which adds the 6th source
 * (worktree scan via `scanWorktrees()`) on top of the sync `loadManifest()`.
 *
 * Coverage:
 *   - Worktree-only oracle (not in any other source) appears with source="worktree".
 *   - Worktree that DUPLICATES a fleet/oracles-json entry merges `localPath`
 *     and adds `worktree` to the entry's `sources` list — does NOT create a
 *     second entry.
 *   - Sync vs async diff — worktree-only entries appear ONLY in the async result.
 *   - TTL caching for `loadManifestCachedAsync` works (and is separate from
 *     the sync cache).
 *   - `invalidateManifest()` clears BOTH sync + async caches.
 *
 * Isolated (per-file subprocess) for the same reason as oracle-manifest.test.ts —
 * we mutate process.env.MAW_CONFIG_DIR before importing the target module.
 *
 * The mock for `scanWorktrees()` is passed by dependency injection via the
 * `scanFn` parameter on `loadManifestAsync` / `loadManifestCachedAsync`. This
 * avoids `mock.module()` pollution — the real `core/fleet/worktrees-scan`
 * module is never loaded in this test, so its SSH transport never fires.
 */
import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Pin CONFIG_DIR + FLEET_DIR before imports ───────────────────────────────
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-manifest-async-841-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
mkdirSync(TEST_FLEET_DIR, { recursive: true });

process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
delete process.env.MAW_HOME;
process.env.MAW_TEST_MODE = "1";

const manifest = await import("../../src/lib/oracle-manifest");
const config = await import("../../src/config");
const {
  loadManifest,
  loadManifestAsync,
  loadManifestCachedAsync,
  invalidateManifest,
  oracleNameFromWorktree,
  DEFAULT_TTL_MS,
} = manifest;

const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [CONFIG_FILE, ORACLES_JSON]) {
    try { rmSync(f, { force: true }); } catch { /* missing is fine */ }
  }
  try {
    rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
    mkdirSync(TEST_FLEET_DIR, { recursive: true });
  } catch { /* best-effort */ }
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

/** Build a mock `scanWorktrees` that returns the given array. */
function mockScan(worktrees: any[]) {
  return async () => worktrees;
}

// ─── oracleNameFromWorktree — name derivation ────────────────────────────────

describe("oracleNameFromWorktree — name derivation", () => {
  test("derives from tmuxWindow ending in -oracle", () => {
    expect(oracleNameFromWorktree({ tmuxWindow: "neo-oracle" })).toBe("neo");
  });

  test("derives from mainRepo basename when tmuxWindow is missing", () => {
    expect(
      oracleNameFromWorktree({ mainRepo: "Soul-Brews-Studio/freshbud-oracle" }),
    ).toBe("freshbud");
  });

  test("tmuxWindow wins over mainRepo basename", () => {
    expect(
      oracleNameFromWorktree({
        tmuxWindow: "actual-oracle",
        mainRepo: "Soul-Brews-Studio/different-oracle",
      }),
    ).toBe("actual");
  });

  test("returns null when neither tmuxWindow nor -oracle suffix matches", () => {
    expect(oracleNameFromWorktree({ mainRepo: "user/random-repo" })).toBeNull();
    expect(oracleNameFromWorktree({})).toBeNull();
  });
});

// ─── Async aggregation — worktree as 6th source ──────────────────────────────

describe("loadManifestAsync — worktree-only oracle surfaces", () => {
  test("worktree-only oracle (no other source) → entry with source='worktree'", async () => {
    const m = await loadManifestAsync(mockScan([
      {
        path: "/tmp/ghq/Soul-Brews-Studio/loner-oracle",
        tmuxWindow: "loner-oracle",
        mainRepo: "Soul-Brews-Studio/loner-oracle",
      },
    ]));

    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.name).toBe("loner");
    expect(e.sources).toEqual(["worktree"]);
    expect(e.localPath).toBe("/tmp/ghq/Soul-Brews-Studio/loner-oracle");
  });

  test("worktree-only oracle derived from mainRepo when tmuxWindow absent", async () => {
    const m = await loadManifestAsync(mockScan([
      {
        path: "/tmp/ghq/Soul-Brews-Studio/quiet-oracle",
        mainRepo: "Soul-Brews-Studio/quiet-oracle",
      },
    ]));
    expect(m).toHaveLength(1);
    expect(m[0].name).toBe("quiet");
    expect(m[0].sources).toContain("worktree");
  });

  test("unbindable worktrees (no -oracle suffix anywhere) are skipped", async () => {
    const m = await loadManifestAsync(mockScan([
      {
        path: "/tmp/some/random-repo",
        mainRepo: "user/random-repo",
      },
    ]));
    expect(m).toEqual([]);
  });
});

describe("loadManifestAsync — duplicate worktrees merge into existing entries", () => {
  test("worktree duplicates a fleet entry → merges localPath, no second entry", async () => {
    writeFleetWindow("200-omni.json", "omni-session", [
      { name: "omni-oracle", repo: "Soul-Brews-Studio/omni-oracle" },
    ]);

    const m = await loadManifestAsync(mockScan([
      {
        path: "/tmp/ghq/Soul-Brews-Studio/omni-oracle",
        tmuxWindow: "omni-oracle",
        mainRepo: "Soul-Brews-Studio/omni-oracle",
      },
    ]));

    // Single merged entry — not two.
    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.name).toBe("omni");
    // Fleet preserved.
    expect(e.session).toBe("omni-session");
    expect(e.window).toBe("omni-oracle");
    expect(e.sources).toContain("fleet");
    // Worktree contributed too.
    expect(e.sources).toContain("worktree");
    // localPath came from worktree (oracles-json wasn't present).
    expect(e.localPath).toBe("/tmp/ghq/Soul-Brews-Studio/omni-oracle");
  });

  test("worktree does NOT clobber an oracles-json localPath", async () => {
    writeOraclesJson([
      makeOraclesEntry({
        name: "owned",
        local_path: "/canonical/path/owned-oracle",
      }),
    ]);

    const m = await loadManifestAsync(mockScan([
      {
        path: "/different/worktree/path",
        tmuxWindow: "owned-oracle",
        mainRepo: "Soul-Brews-Studio/owned-oracle",
      },
    ]));

    expect(m).toHaveLength(1);
    const e = m[0];
    expect(e.localPath).toBe("/canonical/path/owned-oracle");
    expect(e.sources).toContain("oracles-json");
    expect(e.sources).toContain("worktree");
  });
});

describe("loadManifestAsync — sync vs async diff", () => {
  test("worktree-only entries appear ONLY in async result", async () => {
    writeFleetWindow("210-known.json", "known", [{ name: "known-oracle" }]);

    const sync = loadManifest();
    const async_ = await loadManifestAsync(mockScan([
      {
        path: "/tmp/ghq/Soul-Brews-Studio/extra-oracle",
        tmuxWindow: "extra-oracle",
        mainRepo: "Soul-Brews-Studio/extra-oracle",
      },
    ]));

    expect(sync.map((e) => e.name)).toEqual(["known"]);
    expect(async_.map((e) => e.name).sort()).toEqual(["extra", "known"]);

    // The sync entry for `known` is unchanged; the async result also includes
    // it (the worktree didn't claim it, so no merge mutated it either).
    const knownAsync = async_.find((e) => e.name === "known")!;
    expect(knownAsync.sources).not.toContain("worktree");
  });

  test("when scanWorktrees returns empty, async equals sync (by content)", async () => {
    writeFleetWindow("220-empty.json", "e", [{ name: "e-oracle" }]);
    const sync = loadManifest();
    const async_ = await loadManifestAsync(mockScan([]));
    expect(async_.map((e) => e.name)).toEqual(sync.map((e) => e.name));
    expect(async_[0].sources).not.toContain("worktree");
  });
});

// ─── Resilience ──────────────────────────────────────────────────────────────

describe("loadManifestAsync — resilience to scan failure", () => {
  test("scanWorktrees throwing → returns sync manifest, never rejects", async () => {
    writeFleetWindow("230-resil.json", "r", [{ name: "r-oracle" }]);
    const failingScan = async () => {
      throw new Error("ssh: kaboom");
    };
    const m = await loadManifestAsync(failingScan);
    expect(m).toHaveLength(1);
    expect(m[0].name).toBe("r");
    expect(m[0].sources).not.toContain("worktree");
  });
});

// ─── Async TTL cache ─────────────────────────────────────────────────────────

describe("loadManifestCachedAsync — TTL cache", () => {
  test("two calls within TTL → second is cached (does not see new fleet entry)", async () => {
    writeFleetWindow("240-cache-a.json", "first", [{ name: "first-oracle" }]);
    const first = await loadManifestCachedAsync(60_000, mockScan([]));
    expect(first.map((e) => e.name)).toEqual(["first"]);

    writeFleetWindow("241-cache-b.json", "second", [{ name: "second-oracle" }]);
    config.resetConfig();

    const second = await loadManifestCachedAsync(60_000, mockScan([]));
    expect(second).toBe(first);
    expect(second.map((e) => e.name)).toEqual(["first"]);
  });

  test("ttlMs=0 → effectively disables cache (always reload)", async () => {
    writeFleetWindow("242-ttl0-a.json", "a", [{ name: "a-oracle" }]);
    const first = await loadManifestCachedAsync(0, mockScan([]));
    writeFleetWindow("243-ttl0-b.json", "b", [{ name: "b-oracle" }]);
    config.resetConfig();
    const second = await loadManifestCachedAsync(0, mockScan([]));
    expect(first).not.toBe(second);
    expect(second.map((e) => e.name).sort()).toEqual(["a", "b"]);
  });

  test("invalidateManifest() clears BOTH sync and async caches", async () => {
    writeFleetWindow("250-inv-a.json", "x", [{ name: "x-oracle" }]);
    const first = await loadManifestCachedAsync(60_000, mockScan([]));
    expect(first.map((e) => e.name)).toEqual(["x"]);

    writeFleetWindow("251-inv-b.json", "y", [{ name: "y-oracle" }]);
    config.resetConfig();
    invalidateManifest();

    const second = await loadManifestCachedAsync(60_000, mockScan([]));
    expect(second).not.toBe(first);
    expect(second.map((e) => e.name).sort()).toEqual(["x", "y"]);
  });

  test("DEFAULT_TTL_MS is shared with the sync cache (sane default)", () => {
    expect(typeof DEFAULT_TTL_MS).toBe("number");
    expect(DEFAULT_TTL_MS).toBeGreaterThan(0);
  });
});
