/**
 * maw oracle ls — cached grouped inventory enriched with source-lineage
 * and runtime awake state. Replaces the old awake-only list + fleet view.
 *
 * Source of truth: `OracleManifest` (#838) — a unified read-only view that
 * aggregates the 5 oracle registries (fleet windows, config.sessions,
 * config.agents, oracles.json, worktree). Sub-PR 1 of #841.
 *
 * Why manifest > raw oracles.json: an oracle that lives only in `config.sessions`
 * (e.g. just-budded, not yet filesystem-scanned) or only in fleet config (no
 * local checkout) used to be invisible to `maw oracle ls`. Now they all show up.
 *
 * `oracles.json` cache is still read — it's the only source for `local_path`,
 * `org`, `repo` (split form), and lineage timestamps. We auto-refresh the cache
 * on stale/missing as before so first-run UX stays unchanged.
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
import {
  loadManifestCached,
  invalidateManifest,
  type OracleManifestEntry,
} from "../../../lib/oracle-manifest";
import {
  lineageOf,
  timeSince,
  parseDuration,
  parseSince,
  readBirthsCache,
  writeBirthsCache,
  resolveCreatedAtWithCache,
  type OracleLineage,
  type CreatedAt,
  type CreatedSource,
  type ResolveCreatedAtDeps,
} from "./impl-helpers";
import { resolveNickname } from "../../../core/fleet/nicknames";
import { UserError } from "../../../core/util/user-error";

export interface OracleListOpts {
  awake?: boolean;
  org?: string;
  json?: boolean;
  scan?: boolean;
  stale?: boolean;
  path?: boolean;
  /**
   * `--new[=DURATION]` — filter to oracles created within the window.
   * String form: `7d`, `24h`, `2w`, etc. (grammar: ^\d+(s|m|h|d|w)$).
   * Bare `--new` should be normalized by the caller to `"7d"`.
   */
  new?: string;
  /**
   * `--since=ISO_DATE` — absolute lower bound. Takes precedence over --new.
   */
  since?: string;
  /**
   * Test hook — inject the resolveCreatedAt dependencies so we don't
   * shell out to git or touch real filesystem birthtimes in tests.
   */
  _resolveDeps?: ResolveCreatedAtDeps;
}

export interface EnrichedEntry {
  entry: OracleEntry;
  awake: boolean;
  session: string | null;
  lineage: OracleLineage;
  /** Manifest-source labels — useful for future debugging / future flag. */
  sources: string[];
  /** Populated only when --new or --since is active. */
  createdAt?: CreatedAt;
}

/**
 * Build a renderer-compatible `OracleEntry` from a manifest entry, layering
 * any oracles.json metadata we already have on top. Manifest covers the
 * "this oracle exists" fact; `cache.oracles` covers the org/repo/local_path
 * detail (only registry that knows the filesystem path).
 */
function buildEntryFromManifest(
  m: OracleManifestEntry,
  cacheByName: Map<string, OracleEntry>,
  fallbackNode: string | null,
  detectedAt: string,
): OracleEntry {
  const cached = cacheByName.get(m.name);
  if (cached) {
    // oracles.json had this — preserve full metadata, but let manifest
    // contribute a federation_node when oracles.json didn't carry one.
    if (!cached.federation_node && m.node) {
      return { ...cached, federation_node: m.node };
    }
    return cached;
  }

  // Manifest-only oracle (lives in fleet/sessions/agents but not oracles.json).
  // Synthesize a minimal OracleEntry the renderer can format. Repo from
  // manifest may be `org/repo` (fleet) or just `name-oracle` — handle both.
  let org = "(unregistered)";
  let repo = `${m.name}-oracle`;
  if (m.repo) {
    const slash = m.repo.indexOf("/");
    if (slash > 0) {
      org = m.repo.slice(0, slash);
      repo = m.repo.slice(slash + 1);
    } else {
      repo = m.repo;
    }
  }
  return {
    org,
    repo,
    name: m.name,
    local_path: m.localPath ?? "",
    has_psi: m.hasPsi ?? false,
    has_fleet_config: m.hasFleetConfig ?? false,
    budded_from: m.buddedFrom ?? null,
    budded_at: m.buddedAt ?? null,
    federation_node: m.node ?? fallbackNode,
    detected_at: detectedAt,
  };
}

export async function buildEnrichedEntries(opts: { scan?: boolean; stale?: boolean; json?: boolean } = {}): Promise<EnrichedEntry[]> {
  const config = loadConfig();
  const agents = config.agents || {};

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
    invalidateManifest();
  }

  const sessions = await listSessions().catch(() => []);
  const awakeByName = new Map<string, string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.endsWith("-oracle")) {
        const name = w.name.replace(/-oracle$/, "");
        if (!awakeByName.has(name)) awakeByName.set(name, s.name);
      }
    }
  }

  const manifest = loadManifestCached();
  const cacheByName = new Map<string, OracleEntry>(
    (cache?.oracles ?? []).map((e) => [e.name, e]),
  );
  const now = new Date().toISOString();

  const manifestNames = new Set<string>();
  const entries: OracleEntry[] = [];
  const sourcesByName = new Map<string, string[]>();
  for (const m of manifest) {
    manifestNames.add(m.name);
    sourcesByName.set(m.name, [...m.sources]);
    entries.push(
      buildEntryFromManifest(m, cacheByName, config.node || null, now),
    );
  }

  for (const [name] of awakeByName) {
    if (!manifestNames.has(name)) {
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
      sourcesByName.set(name, ["tmux"]);
    }
  }

  return entries.map((entry) => {
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
      sources: sourcesByName.get(entry.name) ?? [],
    };
  });
}

export async function cmdOracleList(opts: OracleListOpts = {}) {
  const enriched = await buildEnrichedEntries(opts);

  // 5. Apply filters
  let filtered = enriched;
  if (opts.awake) filtered = filtered.filter((x) => x.awake);
  if (opts.org) filtered = filtered.filter((x) => x.entry.org === opts.org);

  // 5b. --new / --since — resolve a creation timestamp per row via the
  //     4-tier cascade, then filter to entries within the window.
  //     --since (absolute) takes precedence over --new (relative).
  const newActive = !!(opts.new || opts.since);
  let windowLabel = "";
  if (newActive) {
    let lowerBoundMs: number;
    if (opts.since) {
      const d = parseSince(opts.since);
      if (!d) {
        throw new UserError(
          `--since: invalid date "${opts.since}" (expected ISO date like 2026-05-10)`,
        );
      }
      lowerBoundMs = d.getTime();
      windowLabel = `since ${opts.since}`;
    } else {
      // Default to 7d when --new is bare; caller normalizes "" → "7d".
      const spec = opts.new && opts.new.length > 0 ? opts.new : "7d";
      const ms = parseDuration(spec);
      if (ms === null) {
        throw new UserError(
          `--new: invalid duration "${spec}" (expected like 7d, 24h, 2w)`,
        );
      }
      lowerBoundMs = Date.now() - ms;
      windowLabel = spec;
    }

    const cache = readBirthsCache();
    const resolveDeps = opts._resolveDeps;
    const withTs: EnrichedEntry[] = [];
    for (const x of filtered) {
      const createdAt = await resolveCreatedAtWithCache(x.entry, cache, resolveDeps);
      withTs.push({ ...x, createdAt });
    }
    writeBirthsCache(cache);

    filtered = withTs.filter((x) => {
      const iso = x.createdAt?.iso;
      if (!iso) return false;
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return false;
      return t >= lowerBoundMs;
    });

    // Sort newest first — overrides the org/awake/name sort below.
    filtered.sort((a, b) => {
      const at = new Date(a.createdAt?.iso ?? 0).getTime();
      const bt = new Date(b.createdAt?.iso ?? 0).getTime();
      return bt - at;
    });
  } else {
    // 6. Standard sort — awake first within each org; orgs alphabetical; names alphabetical
    filtered.sort((a, b) => {
      if (a.entry.org !== b.entry.org)
        return a.entry.org.localeCompare(b.entry.org);
      if (a.awake !== b.awake) return a.awake ? -1 : 1;
      return a.entry.name.localeCompare(b.entry.name);
    });
  }

  // 7. JSON output — preserve schema for machine consumers
  const cache = readCache();
  if (opts.json) {
    const out = {
      cache_scanned_at: cache?.local_scanned_at ?? null,
      total: filtered.length,
      awake: filtered.filter((x) => x.awake).length,
      oracles: filtered.map((x) => {
        const base: Record<string, unknown> = {
          ...x.entry,
          awake: x.awake,
          session: x.session,
          lineage: x.lineage,
          sources: x.sources,
        };
        if (newActive) {
          base.created_at = x.createdAt?.iso ?? null;
          base.created_source = x.createdAt?.source ?? "unknown";
        }
        return base;
      }),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 8. Formatted grouped output
  const total = filtered.length;
  const awakeCount = filtered.filter((x) => x.awake).length;
  const age = cache ? timeSince(cache.local_scanned_at) : "?";
  const fresh = cache ? !isCacheStale(cache) : false;
  const staleMark = fresh ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠ stale\x1b[0m";

  if (newActive) {
    console.log(
      `\n  \x1b[36mOracle Fleet — new (${windowLabel})\x1b[0m  (${total} match${total === 1 ? "" : "es"})    cache: ${age} ago ${staleMark}\n`,
    );
  } else {
    console.log(
      `\n  \x1b[36mOracle Fleet\x1b[0m  (${awakeCount} awake / ${total} total)    cache: ${age} ago ${staleMark}\n`,
    );
  }

  if (total === 0) {
    if (newActive) {
      // The spec calls out the friendly empty-state explicitly.
      const label = windowLabel || "7d";
      console.log(
        `  No oracles created in the last ${label}. Try --new=30d.\n`,
      );
    } else if (opts.awake) console.log("  No awake oracles.\n");
    else if (opts.org) console.log(`  No oracles found in org '${opts.org}'.\n`);
    else
      console.log(
        "  No oracles found. Run \x1b[90mmaw oracle scan\x1b[0m to refresh.\n",
      );
    return;
  }

  if (newActive) {
    // Flat newest-first list with Age column — grouping by org would obscure
    // the recency ordering that --new exists to surface.
    for (const x of filtered) {
      console.log(formatRow(x, { showPath: !!opts.path, showAge: true }));
    }
    console.log();
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

export function formatRow(
  x: EnrichedEntry,
  fopts: { showPath: boolean; showAge?: boolean },
): string {
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

  const ageCol =
    fopts.showAge && x.createdAt?.iso
      ? ` \x1b[36m${timeSince(x.createdAt.iso)} ago\x1b[0m`
      : "";

  const displayName = e.nickname
    ? `${e.name} \x1b[90m(${e.nickname})\x1b[0m`
    : e.name;
  // padEnd counts ANSI codes, so pad the plain width then re-embed.
  const plainWidth = e.nickname
    ? `${e.name} (${e.nickname})`.length
    : e.name.length;
  const padding = " ".repeat(Math.max(0, 22 - plainWidth));
  return `    ${icon} ${tag}  ${displayName}${padding} ${lineageNote.padEnd(26)} ${node}${ageCol}${missing}${registerHint}${pathCol}`;
}
