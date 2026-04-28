/**
 * oracle-manifest.ts — unified read-only view across the 5 oracle registries.
 *
 * Sub-issue 2 of #736 Phase 2 / #836.
 *
 * Background
 * ──────────
 * maw-js currently has FIVE independent registries that each describe "what
 * oracles do I know about?" — each authoritative for a different facet:
 *
 *   1. fleet windows         — `<FLEET_DIR>/*.json`               (session+window per oracle)
 *   2. config.sessions       — `Record<oracle, sessionId>`        (claude UUID per oracle)
 *   3. config.agents         — `Record<oracle, node>`             (federation routing)
 *   4. oracle registry cache — `<CONFIG_DIR>/oracles.json`        (filesystem-discovered org/repo metadata)
 *   5. worktree scan         — git worktrees on disk              (fallback discovery)
 *
 * Consumers (`maw oracle ls`, `shouldAutoWake`, `resolveTarget`, `maw doctor`)
 * each implement their own ad-hoc merge across some subset. That's how a fleet
 * window can exist without `config.agents` getting populated for it (fixed in
 * #736 Phase 1.1), or how an `oracles.json` entry can disagree with
 * `config.sessions` and nobody notices.
 *
 * This module is a READ-ONLY view layer. It does NOT replace the registries
 * — operators may still hand-edit any of them. It surfaces a single typed
 * `OracleManifestEntry` per oracle name, with the merge precedence rules
 * documented per field, plus a TTL cache so that consumers can call
 * `loadManifestCached()` cheaply.
 *
 * Pure-ish: the loaders read filesystem state (existing registry files), but
 * never write back. Failure of any one source falls through to "skip that
 * source"; a single corrupt fleet file or missing oracles.json must NOT brick
 * `maw oracle ls`. Each contributing source is exercised independently by
 * the test suite (test/isolated/oracle-manifest.test.ts).
 *
 * Async variant
 * ─────────────
 * `loadManifestAsync()` (Sub-PR 5 of #841) extends `loadManifest()` with the
 * 6th source — `scanWorktrees()` from `core/fleet/worktrees-scan.ts`. It is
 * factored as a separate function (not a flag on the sync loader) because the
 * worktree scan is genuinely async (SSH-y `hostExec` + tmux walks). Existing
 * sync callers stay sync; opt-in consumers pick the async variant.
 *
 * The async variant has its own TTL cache (`loadManifestCachedAsync`) — kept
 * separate from the sync cache because the return shape is async (Promise)
 * and most consumers prefer to not pay the worktree-scan cost on hot paths.
 * `invalidateManifest()` resets BOTH caches.
 *
 * NOT in scope here:
 *   - Federation peers (~/.maw/peers/...) — those describe peer NODES, not
 *     oracles. A future sub-issue will fold peer pubkeys here.
 *
 * See also:
 *   - src/commands/shared/should-auto-wake.ts — Sub-issue 1 (#835).
 *   - src/config/fleet-merge.ts                — load-time fleet→agents merge (#736 Phase 1.1).
 *   - src/core/fleet/oracle-registry.ts        — registry cache producer.
 *   - src/core/fleet/worktrees-scan.ts         — async worktree scanner.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../core/paths";
import { readCache } from "../core/fleet/oracle-registry";
import type { OracleEntry, RegistryCache } from "../core/fleet/oracle-registry";
import { loadConfig } from "../config";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Which registry surfaced a fact. Order matches numeric source precedence
 *  for human-readable diagnostics (`maw doctor` printout). */
export type OracleManifestSource =
  | "fleet"          // <FLEET_DIR>/*.json — fleet config windows
  | "session"        // config.sessions — Claude session UUID per oracle
  | "agent"          // config.agents   — node mapping for federation
  | "oracles-json"   // <CONFIG_DIR>/oracles.json — filesystem-discovered cache
  | "worktree";      // git worktree fallback — populated only by opt-in loader

/**
 * Unified per-oracle entry. Every field except `name` and `sources` is
 * optional because no single registry carries them all. Consumers should
 * branch on `sources.includes(...)` or on the presence of a field rather than
 * on a runtime "is complete?" assertion — the manifest is the truthful merge,
 * not a guarantee of completeness.
 */
export interface OracleManifestEntry {
  /** Oracle short name (window-name minus `-oracle`, or session map key). */
  name: string;

  /** Set of registries that contributed any field for this oracle. */
  sources: OracleManifestSource[];

  /** Federation node ("local", "mba", etc.) — `agent` source primary, fleet/oracles-json fallback. */
  node?: string;

  /** tmux session this oracle's window lives in — `fleet` source only. */
  session?: string;

  /** tmux window name (typically `${name}-oracle`) — `fleet` source only. */
  window?: string;

  /** Repo (org/repo) — `fleet` window.repo or `oracles-json` org+repo. */
  repo?: string;

  /** Local checkout path on this machine — `oracles-json` only. */
  localPath?: string;

  /** Claude session UUID — `session` source only (config.sessions). */
  sessionId?: string;

  /** Lineage: parent oracle this was budded from — `oracles-json`. */
  buddedFrom?: string | null;

  /** Lineage: ISO timestamp of bud — `oracles-json`. */
  buddedAt?: string | null;

  /** Has ψ/ directory on disk — `oracles-json`. */
  hasPsi?: boolean;

  /** Has fleet config on disk — `fleet` source contributes true. */
  hasFleetConfig?: boolean;

  /**
   * Best-effort liveness indicator. The manifest itself does NOT call tmux
   * (that's I/O the loader avoids). Consumers like `maw oracle ls` enrich
   * this from a separate `listSessions()` call. Defaults `false`.
   */
  isLive: boolean;
}

// ─── Source readers (each tolerates failure) ─────────────────────────────────

/** Lite shape — mirrors what we actually pull off fleet windows. */
interface FleetWindowLite {
  name?: string;
  repo?: string;
}
interface FleetSessionLite {
  name?: string;
  windows?: FleetWindowLite[];
}

/** Read fleet windows from FLEET_DIR. Returns `[]` on any failure. */
export function readFleetWindows(dir: string = FLEET_DIR): FleetSessionLite[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".disabled"),
    );
  } catch {
    return [];
  }
  const out: FleetSessionLite[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf-8")) as FleetSessionLite);
    } catch {
      // skip a single malformed fleet file — must not poison the manifest
    }
  }
  return out;
}

/** Strip the `-oracle` suffix from a window name. Returns null when absent. */
function nameFromWindow(window: string | undefined): string | null {
  if (!window) return null;
  if (!window.endsWith("-oracle")) return null;
  return window.replace(/-oracle$/, "");
}

// ─── Merge engine ────────────────────────────────────────────────────────────

/**
 * Aggregate the 5 registries into a single deduplicated list, sorted by name.
 *
 * Precedence rules (per field):
 *   - node:         agent > fleet (`local`) > oracles-json (federation_node)
 *   - session,window: fleet only (other registries don't carry it)
 *   - repo:         fleet (window.repo) > oracles-json (`org/repo`)
 *   - localPath:    oracles-json (only registry with a path)
 *   - sessionId:    config.sessions only
 *   - buddedFrom/At, hasPsi: oracles-json only
 *   - hasFleetConfig: true if fleet contributed
 *   - isLive:        always false in pure load — caller enriches
 *
 * Worktree scan is intentionally NOT included here — see file-level docstring.
 */
export function loadManifest(): OracleManifestEntry[] {
  const config = loadConfig();
  const fleet = readFleetWindows();
  const cache: RegistryCache | null = readCache();
  const sessionsMap = config.sessions || {};
  const agentsMap = config.agents || {};

  const byName = new Map<string, OracleManifestEntry>();

  const ensure = (name: string): OracleManifestEntry => {
    let e = byName.get(name);
    if (!e) {
      e = { name, sources: [], isLive: false };
      byName.set(name, e);
    }
    return e;
  };
  const addSource = (e: OracleManifestEntry, src: OracleManifestSource) => {
    if (!e.sources.includes(src)) e.sources.push(src);
  };

  // 1. fleet — windows give us session/window/repo and "this is fleet-known"
  for (const sess of fleet) {
    for (const w of sess?.windows || []) {
      const name = nameFromWindow(w?.name);
      if (!name) continue;
      const e = ensure(name);
      addSource(e, "fleet");
      e.hasFleetConfig = true;
      // Fleet wins for session/window (only registry with these fields).
      if (sess?.name && e.session === undefined) e.session = sess.name;
      if (w?.name && e.window === undefined) e.window = w.name;
      // repo: fleet wins because it's the active runtime mapping.
      if (w?.repo && e.repo === undefined) e.repo = w.repo;
      // node: fleet implies "local" — agent map can override below.
      if (e.node === undefined) e.node = "local";
    }
  }

  // 2. config.sessions — Claude UUIDs keyed by oracle short name
  for (const [name, sessionId] of Object.entries(sessionsMap)) {
    if (!name) continue;
    const e = ensure(name);
    addSource(e, "session");
    if (typeof sessionId === "string" && sessionId.length > 0) {
      e.sessionId = sessionId;
    }
  }

  // 3. config.agents — node mapping (federation routing).
  //
  //    NOTE on dual conventions: config.agents is populated by two paths
  //    with subtly different key shapes —
  //      • `wake-cmd.ts` writes the SHORT oracle name (`neo` → `local`).
  //      • `fleet-merge.ts` (#736 Phase 1.1) writes the RAW fleet window
  //        name (`neo-oracle` → `local`) at loadConfig time.
  //
  //    We normalize on the way in: any key ending in `-oracle` is stripped.
  //    To make short-name entries win over suffixed entries (the short form
  //    is the explicit operator-driven registration), we walk short-name
  //    keys first.
  const agentEntries = Object.entries(agentsMap);
  const shortAgentKeys = agentEntries.filter(([k]) => k && !k.endsWith("-oracle"));
  const suffixAgentKeys = agentEntries.filter(([k]) => k && k.endsWith("-oracle"));
  for (const [name, node] of shortAgentKeys) {
    const e = ensure(name);
    addSource(e, "agent");
    if (typeof node === "string" && node.length > 0) e.node = node;
  }
  for (const [rawName, node] of suffixAgentKeys) {
    const name = rawName.replace(/-oracle$/, "");
    const e = ensure(name);
    addSource(e, "agent");
    // Only fill in node if the short-name pass didn't already.
    if (typeof node === "string" && node.length > 0 && (e.node === undefined || e.node === "local")) {
      // Defer to fleet's "local" if it set it; otherwise adopt the suffix value.
      if (e.node === undefined) e.node = node;
    }
  }

  // 4. oracles-json — filesystem-discovered metadata. Adds repo, localPath,
  //    lineage. Fleet still wins for session/window/repo on conflict.
  if (cache?.oracles) {
    for (const o of cache.oracles) {
      mergeOraclesJsonEntry(ensure(o.name), o, addSource);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pulled out so the test suite can drive a single oracles-json entry through
 *  the merge in isolation without rebuilding all 5 sources. */
export function mergeOraclesJsonEntry(
  e: OracleManifestEntry,
  o: OracleEntry,
  addSource: (e: OracleManifestEntry, src: OracleManifestSource) => void = (en, src) => {
    if (!en.sources.includes(src)) en.sources.push(src);
  },
): void {
  addSource(e, "oracles-json");
  // Repo: oracles-json fills in if fleet didn't.
  if (e.repo === undefined && o.org && o.repo) e.repo = `${o.org}/${o.repo}`;
  if (e.localPath === undefined && o.local_path) e.localPath = o.local_path;
  if (e.buddedFrom === undefined) e.buddedFrom = o.budded_from;
  if (e.buddedAt === undefined) e.buddedAt = o.budded_at;
  if (e.hasPsi === undefined) e.hasPsi = o.has_psi;
  if (e.hasFleetConfig === undefined) e.hasFleetConfig = o.has_fleet_config;
  // Node: oracles-json is the lowest priority — agent + fleet already populated above.
  if (e.node === undefined && o.federation_node) e.node = o.federation_node;
}

/**
 * Lookup helper — returns the manifest entry for an oracle by short name,
 * or `undefined` if absent. Convenience wrapper over `loadManifest()`; for
 * hot paths use `loadManifestCached()` and keep the result.
 */
export function findOracle(name: string): OracleManifestEntry | undefined {
  return loadManifest().find((e) => e.name === name);
}

// ─── TTL cache ───────────────────────────────────────────────────────────────

/** Default cache TTL — short enough that operator hand-edits show up within
 *  ~30s but long enough that a single CLI invocation reads from cache. */
export const DEFAULT_TTL_MS = 30_000;

interface CacheState {
  manifest: OracleManifestEntry[];
  loadedAt: number;
}

let cacheState: CacheState | null = null;

/**
 * Cached `loadManifest()` — re-uses the in-process result for `ttlMs` ms.
 *
 * The cache is process-local. Tests should call `invalidateManifest()` in
 * `beforeEach`. Production callers can let the TTL expire naturally.
 */
export function loadManifestCached(ttlMs: number = DEFAULT_TTL_MS): OracleManifestEntry[] {
  const now = Date.now();
  if (cacheState && now - cacheState.loadedAt < ttlMs) {
    return cacheState.manifest;
  }
  const manifest = loadManifest();
  cacheState = { manifest, loadedAt: now };
  return manifest;
}

/** Manual cache reset — for tests and post-mutation callers (e.g., after
 *  a fresh `maw oracle scan` rewrites oracles.json). Resets BOTH the sync
 *  and async caches. */
export function invalidateManifest(): void {
  cacheState = null;
  asyncCacheState = null;
}

// ─── Async variant — adds worktree scan as 6th source ────────────────────────

/**
 * Lite shape of `WorktreeInfo` — the fields we actually consume. We avoid
 * importing the `WorktreeInfo` type from `core/fleet/worktrees-scan` directly
 * here so the test suite can fabricate fixtures without pulling in the SSH
 * transport layer that real `scanWorktrees` depends on.
 */
export interface WorktreeLite {
  /** Local checkout path of the worktree on this machine. */
  path?: string;
  /** Bound tmux window, e.g. `"neo-oracle"` when active. */
  tmuxWindow?: string;
  /** Main repo (org/repo), e.g. `"Soul-Brews-Studio/neo-oracle"`. */
  mainRepo?: string;
}

/** A scan function with the same external contract as `scanWorktrees()`. */
export type ScanWorktreesFn = () => Promise<WorktreeLite[]>;

/**
 * Derive the oracle short-name from a worktree, or return `null` if the
 * worktree is not bindable to an oracle (e.g. its main repo doesn't follow
 * the `<name>-oracle` convention and there's no tmux window to read from).
 *
 * Precedence:
 *   1. tmuxWindow ending in `-oracle` (most reliable — explicit binding)
 *   2. mainRepo basename ending in `-oracle` (filesystem fallback)
 */
export function oracleNameFromWorktree(wt: WorktreeLite): string | null {
  // 1. Bound tmux window — `neo-oracle` → `neo`.
  const fromWindow = nameFromWindow(wt?.tmuxWindow);
  if (fromWindow) return fromWindow;

  // 2. Main repo basename — `Soul-Brews-Studio/neo-oracle` → `neo`.
  if (wt?.mainRepo) {
    const basename = wt.mainRepo.split("/").pop() || "";
    if (basename.endsWith("-oracle")) return basename.replace(/-oracle$/, "");
  }
  return null;
}

/**
 * Async variant of `loadManifest()` — same return type, with the 6th source
 * (worktree scan) folded in.
 *
 * Behavior for worktree contributions:
 *   - **New oracle** (not in any other source) → added with `source: "worktree"`,
 *     `localPath = wt.path` if available.
 *   - **Existing oracle** (already surfaced by fleet/session/agent/oracles-json)
 *     → merge `localPath` if not already set; do NOT create a duplicate entry.
 *     The `worktree` source is appended so consumers can see it contributed.
 *
 * Failure isolation matches the sync loader: if `scanWorktrees()` rejects, the
 * async loader still returns the sync result — a flaky tmux/SSH must NOT brick
 * a `maw oracle ls --with-worktrees` command. Errors are swallowed silently;
 * callers wanting visibility into scan failures should call `scanWorktrees()`
 * themselves.
 *
 * @param scanFn Optional scan function injection — defaults to the real
 *               `scanWorktrees()`. Tests pass a synchronous mock here.
 */
export async function loadManifestAsync(
  scanFn?: ScanWorktreesFn,
): Promise<OracleManifestEntry[]> {
  // Start from the synchronous merge — we never want to duplicate that work.
  const base = loadManifest();
  const byName = new Map(base.map((e) => [e.name, e]));

  // Resolve the scan function lazily so importing this module doesn't pay the
  // SSH-transport cost up front, and so the default path is fully optional.
  let scan: ScanWorktreesFn;
  if (scanFn) {
    scan = scanFn;
  } else {
    try {
      const mod = await import("../core/fleet/worktrees-scan");
      scan = mod.scanWorktrees as ScanWorktreesFn;
    } catch {
      // Worktree scanner unavailable — return the sync manifest unchanged.
      return base;
    }
  }

  let worktrees: WorktreeLite[];
  try {
    worktrees = await scan();
  } catch {
    // scanWorktrees() can throw on ssh/tmux failure — fall through to base.
    return base;
  }

  for (const wt of worktrees) {
    const name = oracleNameFromWorktree(wt);
    if (!name) continue;

    let e = byName.get(name);
    if (!e) {
      // Worktree-only oracle — not surfaced by any other registry.
      e = { name, sources: [], isLive: false };
      byName.set(name, e);
    }
    if (!e.sources.includes("worktree")) e.sources.push("worktree");
    // localPath: oracles-json had first dibs; only fill if absent.
    if (e.localPath === undefined && wt?.path) e.localPath = wt.path;
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Async TTL cache ─────────────────────────────────────────────────────────

interface AsyncCacheState {
  manifest: OracleManifestEntry[];
  loadedAt: number;
}

let asyncCacheState: AsyncCacheState | null = null;

/**
 * Cached `loadManifestAsync()` — re-uses the in-process result for `ttlMs` ms.
 *
 * Separate from `loadManifestCached` because the return shape is async and
 * including the worktree scan is opt-in. Most consumers don't need it.
 *
 * @param ttlMs  Cache lifetime in ms (default 30s).
 * @param scanFn Optional scan injection — primarily for tests.
 */
export async function loadManifestCachedAsync(
  ttlMs: number = DEFAULT_TTL_MS,
  scanFn?: ScanWorktreesFn,
): Promise<OracleManifestEntry[]> {
  const now = Date.now();
  if (asyncCacheState && now - asyncCacheState.loadedAt < ttlMs) {
    return asyncCacheState.manifest;
  }
  const manifest = await loadManifestAsync(scanFn);
  asyncCacheState = { manifest, loadedAt: now };
  return manifest;
}
