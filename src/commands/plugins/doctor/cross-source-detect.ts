/**
 * doctor/cross-source-detect.ts — Sub-PR 2 of #841.
 *
 * Cross-source consistency analysis over `OracleManifest` (#838). Unlike
 * `peers/duplicate-detect.ts` (#810) which scans the peer cache for
 * `<oracle>:<node>` collisions, this layer asks a different question:
 *
 *   "For each oracle the manifest knows about, do the 5 registries AGREE
 *    enough that runtime paths (federation routing, awake state, fleet
 *    bring-up) will work?"
 *
 * Underlying fact: `loadConfig()` already auto-merges fleet windows into
 * `config.agents` at load time (src/config/fleet-merge.ts). So a fleet
 * window without an `agent` source label is rare on a healthy box — but
 * an `agent` entry without a backing fleet window IS common when
 * operators hand-edit `maw.config.json` ahead of registering the fleet,
 * or after deleting a fleet json without cleaning the agent map.
 *
 * Pure: takes a manifest snapshot, returns a list of warnings. No fs, no
 * network. The doctor surface adapts findings into the existing
 * `DoctorResult["checks"]` shape; tests can drive `findGaps()` directly.
 *
 * Severity philosophy
 * ───────────────────
 * Every gap is a WARNING, not a hard failure — operators legitimately keep
 * registries partly aligned during migrations (e.g. budding a new oracle
 * into `config.sessions` before its filesystem checkout exists). The
 * doctor entry returns `ok:true` in all cases; the message body counts
 * the gaps. Gating on `ok:false` here would force operators into
 * `--allow-drift` for normal mid-migration states, defeating the purpose.
 */

import type { OracleManifestEntry } from "../../../lib/oracle-manifest";

/** One inconsistency flagged across the 5 registries for a single oracle. */
export interface CrossSourceGap {
  /** Oracle short name. */
  oracle: string;
  /** Stable category — drives test assertions and message templating. */
  kind:
    | "agent-without-fleet"
    | "session-without-fleet"
    | "fleet-without-oracles-json"
    | "oracles-json-without-runtime"
    | "agent-mismatch-fleet-local";
  /** Human-readable hint (one sentence). */
  detail: string;
}

/**
 * Walk the manifest and surface each gap pattern. Pure — feed it the
 * output of `loadManifestCached()` (or a hand-built fixture in tests).
 *
 * Patterns flagged:
 *
 *   1. agent-without-fleet
 *      `agent` source present, `fleet` absent, AND node === "local".
 *      An operator-added entry pointing to local with no fleet window
 *      backing it; `maw hey <name>` will think it's local but find no
 *      tmux session to wake.
 *
 *   2. session-without-fleet
 *      `session` source present, `fleet` absent, no `agent` either —
 *      a budded oracle whose Claude session UUID was recorded but no
 *      fleet window was ever registered. This is the "just-budded but
 *      not yet wired" state; usually transient but worth surfacing.
 *
 *   3. fleet-without-oracles-json
 *      `fleet` source present, `oracles-json` absent, AND no
 *      `localPath`. Indicates the registry cache (`oracles.json`) is
 *      stale relative to fleet; `maw oracle scan` will reconcile.
 *
 *   4. oracles-json-without-runtime
 *      Only `oracles-json` source. Filesystem-discovered oracle that
 *      no fleet/session/agent registry references. Either an orphan
 *      checkout (clone exists, never wired up) or a stale cache entry
 *      pointing at a deleted directory.
 *
 *   5. agent-mismatch-fleet-local
 *      `fleet` AND `agent` both present, but `agent` says a remote
 *      node while fleet implies "local". Federation routing will
 *      prefer the agent value (#736 precedence), so a `maw hey` will
 *      go remote even though there's a local fleet window — almost
 *      certainly a misconfigured agents map after a node migration.
 */
export function findGaps(manifest: OracleManifestEntry[]): CrossSourceGap[] {
  const gaps: CrossSourceGap[] = [];
  for (const e of manifest) {
    const has = (s: string) => e.sources.includes(s as OracleManifestEntry["sources"][number]);
    const hasFleet = has("fleet");
    const hasSession = has("session");
    const hasAgent = has("agent");
    const hasOraclesJson = has("oracles-json");

    // 1. agent-without-fleet — operator-added agent map entry pointing
    //    "local" but no fleet window to back it. Pure agent entries that
    //    point to a remote node are a normal federation routing setup
    //    (no fleet expected on the local box), so we only flag the
    //    `local`-typed ones to avoid false positives.
    if (hasAgent && !hasFleet && e.node === "local") {
      gaps.push({
        oracle: e.name,
        kind: "agent-without-fleet",
        detail:
          `config.agents has '${e.name}' → 'local' but no fleet window registered — ` +
          `'maw hey ${e.name}' will fail to wake. Run 'maw fleet --init-agents' or remove the entry.`,
      });
    }

    // 2. session-without-fleet — Claude session UUID without fleet/agent
    //    registration. Budded-but-not-wired state.
    if (hasSession && !hasFleet && !hasAgent) {
      gaps.push({
        oracle: e.name,
        kind: "session-without-fleet",
        detail:
          `config.sessions has '${e.name}' but no fleet window or agent route — ` +
          `oracle is unreachable. Register a fleet window or remove the session.`,
      });
    }

    // 3. fleet-without-oracles-json — fleet registered but registry
    //    cache hasn't seen it (no oracles-json source AND no localPath).
    //    Pure-fleet entries with localPath happen via routed-only setups
    //    where the operator legitimately has no checkout — only flag
    //    when there's no cache record AND the manifest didn't surface
    //    a path from anywhere.
    if (hasFleet && !hasOraclesJson && !e.localPath) {
      gaps.push({
        oracle: e.name,
        kind: "fleet-without-oracles-json",
        detail:
          `fleet has '${e.name}' but oracles.json has no record and no local checkout known — ` +
          `run 'maw oracle scan' to refresh.`,
      });
    }

    // 4. oracles-json-without-runtime — filesystem-only oracle, no
    //    fleet/session/agent. Orphan checkout or stale cache.
    if (hasOraclesJson && !hasFleet && !hasSession && !hasAgent) {
      gaps.push({
        oracle: e.name,
        kind: "oracles-json-without-runtime",
        detail:
          `oracles.json lists '${e.name}' but no fleet window, session, or agent route — ` +
          `orphan checkout or stale cache. Wake it once or remove the directory.`,
      });
    }

    // 5. agent-mismatch-fleet-local — both fleet and agent contributed,
    //    but the resolved node is NOT "local". Federation will route
    //    away from the local fleet window. We detect this by looking
    //    for entries that have fleet AND a non-local node — fleet's
    //    own contribution would have left node === "local".
    if (hasFleet && hasAgent && e.node && e.node !== "local") {
      gaps.push({
        oracle: e.name,
        kind: "agent-mismatch-fleet-local",
        detail:
          `fleet window for '${e.name}' is local but config.agents points at '${e.node}' — ` +
          `federation will route away from local. Reconcile with 'maw fleet --init-agents' or fix the agent map.`,
      });
    }
  }
  // Stable order: by oracle name, then kind — keeps test assertions
  // and human-readable diff output deterministic.
  gaps.sort((a, b) =>
    a.oracle === b.oracle ? a.kind.localeCompare(b.kind) : a.oracle.localeCompare(b.oracle),
  );
  return gaps;
}

/**
 * Format one gap as a single-line warning suitable for `maw doctor` output.
 * Caller wraps with color codes per its own log surface.
 */
export function formatGap(g: CrossSourceGap): string {
  return `[${g.kind}] ${g.detail}`;
}

/**
 * Aggregate all gaps into a single doctor message body. Returns a tuple of
 * `(headline, lines)` so the doctor renderer can do one-line-per-gap output
 * while still surfacing a compact `message` field on the check result.
 */
export function summarizeGaps(gaps: CrossSourceGap[]): { headline: string; lines: string[] } {
  if (gaps.length === 0) {
    return { headline: "no cross-source inconsistencies", lines: [] };
  }
  const byKind = new Map<string, number>();
  for (const g of gaps) byKind.set(g.kind, (byKind.get(g.kind) ?? 0) + 1);
  const breakdown = [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
  return {
    headline: `${gaps.length} cross-source ${gaps.length === 1 ? "gap" : "gaps"} (${breakdown})`,
    lines: gaps.map(formatGap),
  };
}
