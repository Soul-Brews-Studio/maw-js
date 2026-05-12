import { listSessions, FLEET_DIR, type OracleEntry } from "../../../sdk";
import { ghqFind } from "../../../core/ghq";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../../../core/paths";

/** Like resolveOracle but returns null instead of throwing on miss */
export async function resolveOracleSafe(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string } | { parentDir: ""; repoName: ""; repoPath: "" }> {
  // Try oracle-oracle pattern first, then direct name (e.g., homekeeper → homelab)
  const repoPath = (await ghqFind(`/${oracle}-oracle$`)) ?? (await ghqFind(`/${oracle}$`));
  if (!repoPath) return { parentDir: "", repoName: "", repoPath: "" };
  const repoName = repoPath.split("/").pop()!;
  const parentDir = repoPath.replace(/\/[^/]+$/, "");
  return { repoPath, repoName, parentDir };
}

/** Discover oracles: union of fleet configs + running tmux sessions */
export async function discoverOracles(): Promise<string[]> {
  const names = new Set<string>();

  // 1. Fleet configs (registered — includes sleeping)
  const fleetDir = FLEET_DIR;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      for (const w of config.windows || []) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* fleet dir may not exist */ }

  // 2. Running tmux (actual state — catches unregistered oracles)
  try {
    const sessions = await listSessions();
    for (const s of sessions) {
      for (const w of s.windows) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* tmux not running */ }

  return [...names].sort();
}

export interface OracleStatus {
  name: string;
  session: string | null;
  windows: string[];
  worktrees: number;
  status: "awake" | "sleeping";
}

/**
 * Source-lineage for an oracle entry — "why is this in the list?"
 * Drives the icon column in the grouped `ls` view.
 */
export interface OracleLineage {
  hasFleetConfig: boolean;   // ~/.config/maw/fleet/<name>.json exists
  hasPsi: boolean;           // <repo>/ψ exists
  isAwake: boolean;          // tmux session running
  inAgents: boolean;         // appears in config.agents
  federationNode?: string;   // from config.agents (or entry's federation_node)
}

export function lineageOf(
  entry: OracleEntry,
  awake: boolean,
  agents: Record<string, string>,
): OracleLineage {
  return {
    hasFleetConfig: entry.has_fleet_config,
    hasPsi: entry.has_psi,
    isAwake: awake,
    inAgents: entry.name in agents,
    federationNode: agents[entry.name] ?? entry.federation_node ?? undefined,
  };
}

export function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ─── --new / --since support (#1273) ──────────────────────────────────────────

/**
 * Source label for the cascade result. Stable for JSON output consumers.
 */
export type CreatedSource =
  | "budded_at"
  | "git-claudemd"
  | "fleet-birth"
  | "fs-birth"
  | "unknown";

export interface CreatedAt {
  iso: string | null;
  source: CreatedSource;
}

/**
 * Duration grammar: ^\d+(s|m|h|d|w)$
 * Returns milliseconds, or null when input is malformed.
 */
export function parseDuration(spec: string): number | null {
  const m = /^(\d+)(s|m|h|d|w)$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  switch (unit) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/**
 * Parse an ISO-ish date string (YYYY-MM-DD or full ISO). Returns Date or null.
 */
export function parseSince(spec: string): Date | null {
  // Strict-ish: must contain a digit and parse to a valid Date.
  if (!/\d/.test(spec)) return null;
  const d = new Date(spec);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// Cache lives next to oracles.json so it auto-invalidates with the same
// generation. Format: { version: 1, entries: { <name>: { iso, source, cached_at } } }
const BIRTHS_FILE_NAME = "oracle-births.json";

export interface OracleBirthsCache {
  version: 1;
  entries: Record<string, { iso: string | null; source: CreatedSource; cached_at: string }>;
}

export function getOracleBirthsPath(): string {
  return join(getConfigDir(), BIRTHS_FILE_NAME);
}

/**
 * Read the births cache. Invalidates (returns empty) when oracles.json
 * has been modified more recently than the cache — the spec calls out
 * "invalidate when oracles.json regenerates".
 */
export function readBirthsCache(): OracleBirthsCache {
  const cachePath = getOracleBirthsPath();
  const oraclesPath = join(getConfigDir(), "oracles.json");
  const empty: OracleBirthsCache = { version: 1, entries: {} };
  if (!existsSync(cachePath)) return empty;
  try {
    if (existsSync(oraclesPath)) {
      const cacheMtime = statSync(cachePath).mtimeMs;
      const oraclesMtime = statSync(oraclesPath).mtimeMs;
      // If oracles.json regenerated after this cache was last written, drop it.
      if (oraclesMtime > cacheMtime) return empty;
    }
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (raw?.version === 1 && raw.entries && typeof raw.entries === "object") {
      return raw as OracleBirthsCache;
    }
  } catch {
    // Corrupt cache — start fresh.
  }
  return empty;
}

export function writeBirthsCache(cache: OracleBirthsCache): void {
  try {
    writeFileSync(getOracleBirthsPath(), JSON.stringify(cache, null, 2) + "\n", "utf-8");
  } catch {
    // Cache is purely a perf optimization — never fail the command on cache write.
  }
}

/**
 * Optional dependency injection for resolveCreatedAt — tests stub these so
 * we don't actually shell out to git or touch real filesystem birthtimes.
 */
export interface ResolveCreatedAtDeps {
  /** Run `git log --diff-filter=A --reverse -- CLAUDE.md | head -1` */
  gitFirstCommitDate?: (repoPath: string) => Promise<string | null>;
  /** birthtime of the fleet config file for this oracle */
  fleetConfigBirthtime?: (name: string) => Date | null;
  /** birthtime of <localPath>/CLAUDE.md */
  claudeMdBirthtime?: (localPath: string) => Date | null;
}

async function defaultGitFirstCommitDate(repoPath: string): Promise<string | null> {
  if (!existsSync(join(repoPath, "CLAUDE.md"))) return null;
  try {
    const proc = Bun.spawn(
      ["git", "log", "--diff-filter=A", "--reverse", "--format=%aI", "--", "CLAUDE.md"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const first = text.split("\n").find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

function defaultFleetConfigBirthtime(name: string): Date | null {
  // Search FLEET_DIR for a config that owns a `${name}-oracle` window.
  // We can't predict the fleet filename — operators choose it. Walk the dir.
  try {
    const wantWindow = `${name}-oracle`;
    for (const file of readdirSync(FLEET_DIR)) {
      if (!file.endsWith(".json") || file.endsWith(".disabled")) continue;
      const fullPath = join(FLEET_DIR, file);
      try {
        const conf = JSON.parse(readFileSync(fullPath, "utf-8"));
        const windows = conf?.windows || [];
        for (const w of windows) {
          if (w?.name === wantWindow) {
            return statSync(fullPath).birthtime;
          }
        }
      } catch {
        // skip malformed fleet file
      }
    }
  } catch {
    // FLEET_DIR may not exist
  }
  return null;
}

function defaultClaudeMdBirthtime(localPath: string): Date | null {
  if (!localPath) return null;
  try {
    const p = join(localPath, "CLAUDE.md");
    if (!existsSync(p)) return null;
    return statSync(p).birthtime;
  } catch {
    return null;
  }
}

/**
 * Resolve a creation timestamp for an oracle via the 4-tier cascade (#1273):
 *   1. budded_at (canonical, set by `maw bud`)
 *   2. git first commit of CLAUDE.md (canonical for hand-awakened)
 *   3. fleet config birthtime (strong proxy for fleet-only)
 *   4. local path CLAUDE.md birthtime (weak — resets on re-clone)
 *
 * The git tier shells out, so callers should consult the cache first via
 * `resolveCreatedAtWithCache()` instead of calling this directly per-row.
 */
export async function resolveCreatedAt(
  entry: OracleEntry,
  deps: ResolveCreatedAtDeps = {},
): Promise<CreatedAt> {
  const git = deps.gitFirstCommitDate ?? defaultGitFirstCommitDate;
  const fleetBirth = deps.fleetConfigBirthtime ?? defaultFleetConfigBirthtime;
  const fsBirth = deps.claudeMdBirthtime ?? defaultClaudeMdBirthtime;

  // Tier 1 — canonical budded_at
  if (entry.budded_at) {
    return { iso: entry.budded_at, source: "budded_at" };
  }

  // Tier 2 — git first commit of CLAUDE.md (only if we have a local checkout)
  if (entry.local_path) {
    const iso = await git(entry.local_path);
    if (iso) return { iso, source: "git-claudemd" };
  }

  // Tier 3 — fleet config birthtime
  const fb = fleetBirth(entry.name);
  if (fb && !Number.isNaN(fb.getTime()) && fb.getTime() > 0) {
    return { iso: fb.toISOString(), source: "fleet-birth" };
  }

  // Tier 4 — local CLAUDE.md birthtime
  if (entry.local_path) {
    const cb = fsBirth(entry.local_path);
    if (cb && !Number.isNaN(cb.getTime()) && cb.getTime() > 0) {
      return { iso: cb.toISOString(), source: "fs-birth" };
    }
  }

  return { iso: null, source: "unknown" };
}

/**
 * Cache-aware wrapper. Reuses the git-first-commit result across runs so
 * `maw oracle ls --new` doesn't re-shell `git log` for every oracle every
 * time. Cache invalidates when oracles.json regenerates (mtime comparison).
 *
 * Tier 1 (budded_at) is NEVER cached — it's a free field read.
 * Tier 3/4 (birthtime) are cached because statSync is cheap but consistency
 *   with the git tier keeps the JSON shape stable across calls.
 */
export async function resolveCreatedAtWithCache(
  entry: OracleEntry,
  cache: OracleBirthsCache,
  deps: ResolveCreatedAtDeps = {},
): Promise<CreatedAt> {
  // budded_at is canonical and free — short-circuit without touching the cache.
  if (entry.budded_at) {
    return { iso: entry.budded_at, source: "budded_at" };
  }
  const cached = cache.entries[entry.name];
  if (cached && cached.source !== "unknown") {
    return { iso: cached.iso, source: cached.source };
  }
  const resolved = await resolveCreatedAt(entry, deps);
  if (resolved.source !== "unknown") {
    cache.entries[entry.name] = {
      iso: resolved.iso,
      source: resolved.source,
      cached_at: new Date().toISOString(),
    };
  }
  return resolved;
}
