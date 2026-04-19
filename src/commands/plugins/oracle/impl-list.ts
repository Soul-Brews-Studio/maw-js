/**
 * maw oracle ls — cached grouped inventory enriched with source-lineage
 * and runtime awake state. Replaces the old awake-only list + fleet view.
 *
 * Reads the oracle registry cache (~/.config/maw/oracles.json) so it shows
 * ALL oracles the user has, not just the ones currently running in tmux.
 * Auto-bootstraps the cache on first use.
 *
 * Flags:
 *   --awake   filter to running tmux sessions only
 *   --org X   filter to org X
 *   --json    machine output
 *   --scan    refresh cache before listing
 *   --stale   skip auto-refresh on stale cache
 *   --path    show local filesystem paths
 */

import {
  listSessions,
  readCache,
  scanAndCache,
  isCacheStale,
  loadConfig,
  type OracleEntry,
} from "../../../sdk";
import { lineageOf, timeSince, type OracleLineage } from "./impl-helpers";
import { resolveNickname } from "../../../core/fleet/nicknames";

export interface OracleListOpts {
  awake?: boolean;
  org?: string;
  json?: boolean;
  scan?: boolean;
  stale?: boolean;
  path?: boolean;
}

interface EnrichedEntry {
  entry: OracleEntry;
  awake: boolean;
  session: string | null;
  lineage: OracleLineage;
}

export async function cmdOracleList(opts: OracleListOpts = {}) {
  const config = loadConfig();
  const agents = config.agents || {};

  // 1. Cache: --scan forces refresh; empty cache auto-bootstraps; stale cache
  //    refreshes unless --stale. Edge case: offline scanLocal still succeeds
  //    (filesystem walk, no network). Only scan --remote hits GitHub.
  let cache = readCache();
  const shouldRefresh =
    !!opts.scan || !cache || (isCacheStale(cache) && !opts.stale);
  if (shouldRefresh) {
    if (!cache && !opts.json) {
      console.log(
        `\n  \x1b[33m📡\x1b[0m No oracle cache — running first local scan...\n`,
      );
    }
    cache = scanAndCache("local");
  }

  // 2. Live tmux snapshot — used for awake state + surfacing just-budded
  //    oracles that haven't landed in the cache yet.
  const sessions = await listSessions().catch(() => []);
  const awakeByName = new Map<string, string>(); // name → session
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.endsWith("-oracle")) {
        const name = w.name.replace(/-oracle$/, "");
        if (!awakeByName.has(name)) awakeByName.set(name, s.name);
      }
    }
  }

  // 3. Merge in tmux-only oracles (just budded, not yet in cache)
  const entries: OracleEntry[] = [...cache!.oracles];
  const entryNames = new Set(entries.map((e) => e.name));
  const now = new Date().toISOString();
  for (const [name] of awakeByName) {
    if (!entryNames.has(name)) {
      entries.push({
        org: "(unregistered)",
        repo: `${name}-oracle`,
        name,
        local_path: "",
        has_psi: false,
        has_fleet_config: false,
        budded_from: null,
        budded_at: null,
        federation_node: config.node || null,
        detected_at: now,
      });
    }
  }

  // 4. Enrich each entry with awake state + lineage + nickname (read-through)
  const enriched: EnrichedEntry[] = entries.map((entry) => {
    const session = awakeByName.get(entry.name) ?? null;
    const awake = session !== null;
    const nickname = resolveNickname(entry.name, entry.local_path || null);
    const enrichedEntry: OracleEntry = nickname
      ? { ...entry, nickname }
      : entry;
    return {
      entry: enrichedEntry,
      awake,
      session,
      lineage: lineageOf(entry, awake, agents),
    };
  });

  // 5. Apply filters
  let filtered = enriched;
  if (opts.awake) filtered = filtered.filter((x) => x.awake);
  if (opts.org) filtered = filtered.filter((x) => x.entry.org === opts.org);

  // 6. Sort — awake first within each org; orgs alphabetical; names alphabetical
  filtered.sort((a, b) => {
    if (a.entry.org !== b.entry.org)
      return a.entry.org.localeCompare(b.entry.org);
    if (a.awake !== b.awake) return a.awake ? -1 : 1;
    return a.entry.name.localeCompare(b.entry.name);
  });

  // 7. JSON output — preserve schema for machine consumers
  if (opts.json) {
    const out = {
      cache_scanned_at: cache!.local_scanned_at,
      total: filtered.length,
      awake: filtered.filter((x) => x.awake).length,
      oracles: filtered.map((x) => ({
        ...x.entry,
        awake: x.awake,
        session: x.session,
        lineage: x.lineage,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 8. Formatted grouped output
  const total = filtered.length;
  const awakeCount = filtered.filter((x) => x.awake).length;
  const age = timeSince(cache!.local_scanned_at);
  const fresh = !isCacheStale(cache!);
  const staleMark = fresh ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠ stale\x1b[0m";

  console.log(
    `\n  \x1b[36mOracle Fleet\x1b[0m  (${awakeCount} awake / ${total} total)    cache: ${age} ago ${staleMark}\n`,
  );

  if (total === 0) {
    if (opts.awake) console.log("  No awake oracles.\n");
    else if (opts.org) console.log(`  No oracles found in org '${opts.org}'.\n`);
    else
      console.log(
        "  No oracles found. Run \x1b[90mmaw oracle scan\x1b[0m to refresh.\n",
      );
    return;
  }

  // Group by org for display
  const byOrg = new Map<string, EnrichedEntry[]>();
  for (const x of filtered) {
    const list = byOrg.get(x.entry.org) || [];
    list.push(x);
    byOrg.set(x.entry.org, list);
  }

  for (const [org, items] of byOrg) {
    console.log(`  \x1b[90m${org}\x1b[0m (${items.length}):`);
    for (const x of items) {
      console.log(formatRow(x, { showPath: !!opts.path }));
    }
    console.log();
  }
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatRow(x: EnrichedEntry, fopts: { showPath: boolean }): string {
  const { entry: e, awake, lineage } = x;

  // Icon + tag mapping:
  //   ●  fleet config + tmux awake
  //   ○  fleet config, no tmux (sleeping)
  //   ·  filesystem only (has ψ/ or -oracle suffix but no fleet registration)
  //   faint ·  suspicious (just -oracle suffix, no ψ/, no fleet)
  let icon: string;
  let tag: string;
  if (lineage.hasFleetConfig && awake) {
    icon = "\x1b[32m●\x1b[0m";
    tag = "fleet+awake";
  } else if (lineage.hasFleetConfig) {
    icon = "\x1b[90m○\x1b[0m";
    tag = "fleet      ";
  } else if (lineage.hasPsi) {
    icon = "\x1b[33m·\x1b[0m";
    tag = "fs         ";
  } else {
    icon = "\x1b[90m·\x1b[0m";
    tag = "\x1b[90mfs (?)     \x1b[0m";
  }

  const lineageNote = e.budded_from
    ? `budded from ${e.budded_from}`
    : lineage.hasPsi
      ? "oracle (ψ/)"
      : lineage.hasFleetConfig
        ? "fleet-only"
        : "uncertain";

  const node = lineage.federationNode ? `· ${lineage.federationNode}` : "";
  const missing = !e.local_path ? " \x1b[33m(not cloned)\x1b[0m" : "";

  let registerHint = "";
  if (!lineage.hasFleetConfig && e.local_path) {
    registerHint = ` \x1b[90m(not registered)\x1b[0m`;
  }

  const pathCol =
    fopts.showPath && e.local_path
      ? `\n        \x1b[90m${e.local_path}\x1b[0m`
      : "";

  const displayName = e.nickname
    ? `${e.name} \x1b[90m(${e.nickname})\x1b[0m`
    : e.name;
  // padEnd counts ANSI codes, so pad the plain width then re-embed.
  const plainWidth = e.nickname
    ? `${e.name} (${e.nickname})`.length
    : e.name.length;
  const padding = " ".repeat(Math.max(0, 22 - plainWidth));
  return `    ${icon} ${tag}  ${displayName}${padding} ${lineageNote.padEnd(26)} ${node}${missing}${registerHint}${pathCol}`;
}
