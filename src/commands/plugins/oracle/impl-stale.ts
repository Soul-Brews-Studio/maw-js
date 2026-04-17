/**
 * maw oracle scan --stale — read-only staleness classifier (issue #392).
 *
 * Scope: SCAN ONLY. Prune / register / delete verbs deferred to #383.
 *
 * Tiers (per gist 0721cb33):
 *   ACTIVE  commit < 7d (or awake in tmux)
 *   SLOW    commit 7–30d
 *   STALE   commit 30–90d
 *   DEAD    commit > 90d, or no commits found
 *
 * Source of truth: registry cache (oracle entries with local_path) + tmux
 * liveness. For each cloned repo we read the last commit date via git log;
 * missing clones or commit-less repos fall into DEAD.
 */
import { readCache, scanAndCache, listSessions, type OracleEntry } from "../../../sdk";
import { execSync } from "child_process";

export type StaleTier = "ACTIVE" | "SLOW" | "STALE" | "DEAD";

export interface StaleEntry {
  name: string;
  org: string;
  repo: string;
  local_path: string;
  has_psi: boolean;
  awake: boolean;
  last_commit: string | null;   // ISO8601
  days_since_commit: number | null;
  tier: StaleTier;
  recommendation: string;
}

const ACTIVE_MAX_DAYS = 7;
const SLOW_MAX_DAYS = 30;
const STALE_MAX_DAYS = 90;

const TIER_ORDER: Record<StaleTier, number> = { DEAD: 0, STALE: 1, SLOW: 2, ACTIVE: 3 };

export function classifyStaleness(args: {
  entry: OracleEntry;
  lastCommitISO: string | null;
  awake: boolean;
  now?: Date;
}): StaleEntry {
  const { entry, lastCommitISO, awake } = args;
  const now = args.now ?? new Date();

  let daysSince: number | null = null;
  if (lastCommitISO) {
    const ms = now.getTime() - new Date(lastCommitISO).getTime();
    daysSince = Math.floor(ms / 86_400_000);
  }

  let tier: StaleTier;
  let recommendation: string;

  if (awake) {
    tier = "ACTIVE";
    recommendation = "awake in tmux";
  } else if (daysSince === null) {
    tier = "DEAD";
    recommendation = entry.local_path
      ? "no commits found — investigate"
      : "not cloned — investigate";
  } else if (daysSince < ACTIVE_MAX_DAYS) {
    tier = "ACTIVE";
    recommendation = "recent activity";
  } else if (daysSince < SLOW_MAX_DAYS) {
    tier = "SLOW";
    recommendation = "monitor";
  } else if (daysSince < STALE_MAX_DAYS) {
    tier = "STALE";
    recommendation = "investigate";
  } else {
    tier = "DEAD";
    recommendation = entry.has_psi
      ? "archive (has ψ/)"
      : "prune candidate (no ψ/)";
  }

  return {
    name: entry.name,
    org: entry.org,
    repo: entry.repo,
    local_path: entry.local_path,
    has_psi: entry.has_psi,
    awake,
    last_commit: lastCommitISO,
    days_since_commit: daysSince,
    tier,
    recommendation,
  };
}

export function sortByStaleness(entries: StaleEntry[]): StaleEntry[] {
  return [...entries].sort((a, b) => {
    if (a.tier !== b.tier) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    const aD = a.days_since_commit ?? Infinity;
    const bD = b.days_since_commit ?? Infinity;
    if (aD !== bD) return bD - aD;  // oldest first within tier
    return a.name.localeCompare(b.name);
  });
}

/** Read the last commit date (ISO) from a repo. Returns null on any failure. */
export function lastCommitAt(localPath: string): string | null {
  if (!localPath) return null;
  try {
    const out = execSync(
      "git log -1 --format=%cI",
      { cwd: localPath, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface StaleScanOpts {
  json?: boolean;
  all?: boolean;   // include ACTIVE+SLOW in output; default shows STALE+DEAD
}

/**
 * Drive the scan: entries come from registry cache, tmux liveness from tmux.
 * Injectable deps keep the driver testable without touching disk or tmux.
 */
export async function runStaleScan(
  opts: StaleScanOpts = {},
  deps: {
    readEntries?: () => OracleEntry[];
    listAwake?: () => Promise<Set<string>>;
    getLastCommit?: (localPath: string) => string | null;
    now?: () => Date;
  } = {},
): Promise<StaleEntry[]> {
  const readEntries = deps.readEntries ?? (() => {
    const cache = readCache() ?? scanAndCache("local");
    return cache.oracles;
  });
  const listAwake = deps.listAwake ?? (async () => {
    const sessions = await listSessions().catch(() => []);
    const awake = new Set<string>();
    for (const s of sessions) {
      for (const w of s.windows) {
        if (w.name.endsWith("-oracle")) awake.add(w.name.replace(/-oracle$/, ""));
      }
    }
    return awake;
  });
  const getLastCommit = deps.getLastCommit ?? lastCommitAt;
  const now = deps.now ?? (() => new Date());

  const entries = readEntries();
  const awakeSet = await listAwake();
  const nowDate = now();

  const classified = entries.map((entry) =>
    classifyStaleness({
      entry,
      lastCommitISO: getLastCommit(entry.local_path),
      awake: awakeSet.has(entry.name),
      now: nowDate,
    }),
  );

  const sorted = sortByStaleness(classified);
  return opts.all ? sorted : sorted.filter((e) => e.tier === "STALE" || e.tier === "DEAD");
}

export async function cmdOracleScanStale(opts: StaleScanOpts = {}): Promise<void> {
  const results = await runStaleScan(opts);

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, count: results.length, oracles: results }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`\n  \x1b[32m✓\x1b[0m No stale oracles — all clear.\n`);
    return;
  }

  const counts: Record<StaleTier, number> = { ACTIVE: 0, SLOW: 0, STALE: 0, DEAD: 0 };
  for (const r of results) counts[r.tier]++;
  const banner =
    `DEAD ${counts.DEAD}  STALE ${counts.STALE}` +
    (opts.all ? `  SLOW ${counts.SLOW}  ACTIVE ${counts.ACTIVE}` : "");
  console.log(`\n  \x1b[36mStale oracle scan\x1b[0m  (${banner})\n`);

  let currentTier: StaleTier | null = null;
  for (const r of results) {
    if (r.tier !== currentTier) {
      currentTier = r.tier;
      const color = r.tier === "DEAD" ? 31 : r.tier === "STALE" ? 33 : r.tier === "SLOW" ? 90 : 32;
      console.log(`  \x1b[${color}m${r.tier}\x1b[0m`);
    }
    const age = r.days_since_commit === null ? "?" : `${r.days_since_commit}d`;
    const psi = r.has_psi ? "ψ/" : "  ";
    console.log(
      `    ${psi}  ${r.name.padEnd(22)} ${age.padStart(5)} ago  \x1b[90m${r.recommendation}\x1b[0m`,
    );
  }
  console.log();
}
