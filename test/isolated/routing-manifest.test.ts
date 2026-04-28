/**
 * routing-manifest.test.ts — Sub-PR 3 of #841 (final).
 *
 * Verifies that `resolveTarget()` consults the unified `OracleManifest` (#838 +
 * #863) as the PRIMARY lookup before falling back to `config.agents`. The new
 * step 3a sits between node:prefix routing (Step 2) and the legacy agents-map
 * step (Step 3b) — see `src/core/routing.ts`.
 *
 * Coverage:
 *   1. Manifest hit (remote node + peer URL in config)            → returns peer
 *   2. Manifest miss                                              → falls through to agents map
 *   3. Manifest hit but node === selfNode                         → falls through (local takes priority)
 *   4. Manifest hit but node has NO peer URL in passed config     → falls through to agents map
 *   5. Manifest hit AND agents map hit (different nodes)          → manifest wins
 *   6. Manifest hit via `-oracle`-stripped variant                → returns peer
 *   7. Manifest hit but local session exists                      → local STILL wins (Step 1 first)
 *   8. Manifest hit but query is `node:agent` form                → manifest skipped (Step 2 path)
 *   9. Manifest read failure (loader throws)                      → falls through gracefully
 *
 * Isolated subprocess because we install a `mock.module()` for
 * `src/lib/oracle-manifest` BEFORE importing the routing module. Mirrors the
 * pattern used by `hey-fleet-auto-wake.test.ts` (the Sub-PR 4 callsite).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { join } from "path";
import type { OracleManifestEntry } from "../../src/lib/oracle-manifest";
import type { Session } from "../../src/core/runtime/find-window";
import type { MawConfig } from "../../src/config";

// ─── Manifest mock ───────────────────────────────────────────────────────────
//
// Holds the manifest the loader will surface to `resolveTarget`. Each test
// rewrites it in `beforeEach` (or inline) and the mocked `loadManifestCached`
// returns whatever's in the slot. `loadManifestThrows` flips error-path tests.

let manifestEntries: OracleManifestEntry[] = [];
let loadManifestThrows = false;

mock.module(join(import.meta.dir, "../../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => {
    if (loadManifestThrows) throw new Error("manifest load failure (test)");
    return manifestEntries;
  },
  loadManifest: () => {
    if (loadManifestThrows) throw new Error("manifest load failure (test)");
    return manifestEntries;
  },
  // findOracle is unused by routing, but exported so other modules pulling
  // this barrel during the test run don't break.
  findOracle: (name: string) => manifestEntries.find((e) => e.name === name),
  invalidateManifest: () => { manifestEntries = []; },
  loadManifestAsync: async () => manifestEntries,
  loadManifestCachedAsync: async () => manifestEntries,
  readFleetWindows: () => [],
  mergeOraclesJsonEntry: () => {},
  oracleNameFromWorktree: () => null,
  DEFAULT_TTL_MS: 30_000,
}));

// Late import — must happen AFTER the mock above.
const { resolveTarget } = await import("../../src/core/routing");

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSIONS: Session[] = [
  { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
  { name: "13-mother", windows: [{ index: 1, name: "mother-oracle", active: true }] },
];

const BASE_CONFIG: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/home/nat/Code/github.com",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  node: "white",
  namedPeers: [
    { name: "mba", url: "http://10.20.0.3:3457" },
    { name: "oracle-world", url: "http://100.120.242.120:3456" },
  ],
  agents: {
    homekeeper: "mba",
  },
  peers: ["http://10.20.0.3:3457"],
};

function entry(o: Partial<OracleManifestEntry> & { name: string }): OracleManifestEntry {
  return {
    sources: ["fleet"],
    isLive: false,
    ...o,
  } as OracleManifestEntry;
}

beforeEach(() => {
  manifestEntries = [];
  loadManifestThrows = false;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resolveTarget — manifest as primary lookup (Sub-PR 3 of #841)", () => {
  // 1. Manifest hit on a remote node with a known peer URL → peer route.
  test("manifest hit with remote node + peer URL → returns peer entry", () => {
    manifestEntries = [
      entry({ name: "boonkeeper", sources: ["fleet", "agent"], node: "oracle-world" }),
    ];
    const r = resolveTarget("boonkeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://100.120.242.120:3456",
      target: "boonkeeper",
      node: "oracle-world",
    });
  });

  // 2. Manifest miss → falls through to agents map.
  test("manifest miss → falls through to agents map", () => {
    manifestEntries = []; // empty manifest
    const r = resolveTarget("homekeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://10.20.0.3:3457",
      target: "homekeeper",
      node: "mba",
    });
  });

  // 3. Manifest entry with self-node → does not short-circuit (local wins).
  test("manifest entry with node === selfNode → falls through to existing logic", () => {
    manifestEntries = [
      entry({ name: "ghost", sources: ["session"], node: "white" }),
    ];
    // No local match for "ghost", no agents map entry → not_found.
    const r = resolveTarget("ghost", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "not_found" });
  });

  // 3b. Manifest entry with node === "local" → also treated as self-node-ish.
  test("manifest entry with node === 'local' → falls through (treated as self)", () => {
    manifestEntries = [
      entry({ name: "fleet-only", sources: ["fleet"], node: "local" }),
    ];
    const r = resolveTarget("fleet-only", BASE_CONFIG, SESSIONS);
    // No local session, no agents entry → not_found, NOT a peer route.
    expect(r).toMatchObject({ type: "error", reason: "not_found" });
  });

  // 4. Manifest hit but no peer URL for that node → falls through.
  test("manifest hit, remote node, but no peer URL → falls through", () => {
    manifestEntries = [
      entry({ name: "farboon", sources: ["oracles-json"], node: "mars" }),
    ];
    const r = resolveTarget("farboon", BASE_CONFIG, SESSIONS);
    // Falls through; not in agents map either → not_found.
    expect(r).toMatchObject({ type: "error", reason: "not_found" });
  });

  // 5. Manifest hit AND agents map hit (different nodes) → manifest wins.
  //    This is the "primary lookup" property — the manifest is the unified view.
  test("manifest and agents map disagree → manifest wins", () => {
    manifestEntries = [
      entry({ name: "homekeeper", sources: ["fleet", "agent"], node: "oracle-world" }),
    ];
    // BASE_CONFIG.agents.homekeeper === "mba", but manifest says "oracle-world".
    const r = resolveTarget("homekeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://100.120.242.120:3456",
      target: "homekeeper",
      node: "oracle-world",
    });
  });

  // 6. Manifest entry matched via `-oracle` suffix strip.
  test("manifest hit via -oracle suffix strip → returns peer", () => {
    manifestEntries = [
      entry({ name: "boonkeeper", sources: ["fleet"], node: "oracle-world" }),
    ];
    const r = resolveTarget("boonkeeper-oracle", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://100.120.242.120:3456",
      target: "boonkeeper-oracle",
      node: "oracle-world",
    });
  });

  // 7. Local session match (Step 1) ALWAYS wins, even with manifest hit.
  test("local session match wins over manifest entry", () => {
    manifestEntries = [
      // Manifest claims mother-oracle is on a remote node, but Step 1 should
      // route to the local session before manifest is consulted.
      entry({ name: "mother", sources: ["agent"], node: "oracle-world" }),
      entry({ name: "mother-oracle", sources: ["agent"], node: "oracle-world" }),
    ];
    const r = resolveTarget("mother-oracle", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({ type: "local", target: "13-mother:1" });
  });

  // 8. node:agent form skips manifest (Step 2 path is authoritative).
  test("node:agent form bypasses manifest lookup → uses Step 2", () => {
    manifestEntries = [
      // Manifest claims homekeeper is on oracle-world, but the explicit
      // "mba:homekeeper" syntax MUST honor the user's node specifier.
      entry({ name: "homekeeper", sources: ["agent"], node: "oracle-world" }),
    ];
    const r = resolveTarget("mba:homekeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://10.20.0.3:3457",
      target: "homekeeper",
      node: "mba",
    });
  });

  // 9. Manifest loader throws → resolveTarget recovers, falls through.
  test("manifest load error swallowed → falls through to agents map", () => {
    loadManifestThrows = true;
    const r = resolveTarget("homekeeper", BASE_CONFIG, SESSIONS);
    // Should still resolve via agents map (BASE_CONFIG.agents.homekeeper = "mba").
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://10.20.0.3:3457",
      target: "homekeeper",
      node: "mba",
    });
  });

  // Empty manifest (no entries) is a baseline guarantee — equivalent to
  // pre-#841 routing behavior across the entire suite.
  test("empty manifest is a no-op — agents map continues to drive routing", () => {
    manifestEntries = [];
    const r = resolveTarget("homekeeper", BASE_CONFIG, SESSIONS);
    expect(r).toEqual({
      type: "peer",
      peerUrl: "http://10.20.0.3:3457",
      target: "homekeeper",
      node: "mba",
    });
  });

  // Manifest entry with no `node` field → can't drive routing, falls through.
  test("manifest entry with no node field → falls through", () => {
    manifestEntries = [
      // session-only entry — has sessionId but no federation node.
      entry({ name: "ghost", sources: ["session"], sessionId: "uuid-ghost" }),
    ];
    const r = resolveTarget("ghost", BASE_CONFIG, SESSIONS);
    expect(r).toMatchObject({ type: "error", reason: "not_found" });
  });
});
