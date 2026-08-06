/**
 * cleanup/internal/prune-stale-oracles.ts — `maw cleanup --prune-stale` (#41).
 *
 * Bulk-removes dead oracles.json entries that no fleet window, no
 * config.sessions UUID, and no config.agents route reference. Without this,
 * `maw doctor` flags `oracles-json-without-runtime` 99× on a healthy operator
 * machine and tells the user "remove the directory" — there was no CLI
 * affordance to act on it in bulk.
 *
 * Safety rails (all checked BEFORE bucketing):
 *
 *   1. PWD self-exclude — never prune the entry whose `local_path` is
 *      `process.cwd()` or one of its ancestors. The operator is standing
 *      INSIDE the candidate clone; the registry record is presumed live.
 *   2. ψ vault wins — `has_psi: true` means "intentional dormant oracle",
 *      skip entirely (kept count surfaced in the summary).
 *   3. Clone missing → SAFE (the disk entry is already dead).
 *
 * Decision tree (applied per surviving stale entry, after probing disk + git):
 *
 *   - NEVER-TOUCH: uncommitted work (`git status --porcelain` non-empty) OR
 *                  unpushed commits ahead of upstream OR detached HEAD with
 *                  commits.
 *   - ASK-FIRST:   clean git, recent mtime (≤8 days) or "intentional
 *                  placeholder" size band (124-128 K — empirically the size
 *                  of a freshly-budded oracle scaffold), or between 8 and 30
 *                  days old.
 *   - SAFE:        empty repo (no commits) OR clean + mtime ≥ 30 days.
 *
 * Concurrency: git probes are fanned out with a small semaphore (cap = 8) so
 * `maw cleanup --prune-stale` on a 100-entry registry takes a second or two
 * instead of a minute.
 *
 * Pure-ish: I/O (manifest read, oracles.json read/write, git, du, stat) is
 * injectable via the `PruneEnv` shape so tests drive deterministic fixtures
 * without touching the operator's real registry.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { loadManifest, type OracleManifestEntry } from "maw-js/lib/oracle-manifest";
import { mawCachePath, mawConfigPath } from "../../../../core/xdg";

// ─── Types ───────────────────────────────────────────────────────────────────

/** OracleEntry shape lifted from maw-js/core/fleet/registry-oracle-types.
 *  Inlined here so we don't depend on an unexported internal path. */
export interface OracleEntryLite {
  org: string;
  repo: string;
  name: string;
  local_path: string;
  has_psi: boolean;
  has_fleet_config: boolean;
  budded_from: string | null;
  budded_at: string | null;
  federation_node: string | null;
  detected_at: string;
  [k: string]: unknown;
}

export interface DirStat {
  /** mtime in epoch ms */
  mtimeMs: number;
  /** total directory size in bytes (du -sk × 1024). */
  sizeBytes: number;
}

export interface GitStat {
  /** porcelain empty */
  isClean: boolean;
  /** commits ahead of `@{u}` — 0 when no upstream */
  unpushed: number;
  /** line count of `status --porcelain` */
  uncommitted: number;
  /** total commits reachable from HEAD (0 = empty repo) */
  totalCommits: number;
  /** detached HEAD (no symbolic ref) */
  detached: boolean;
}

export type Bucket = "never-touch" | "ask-first" | "safe";

export interface PruneCandidate {
  entry: OracleEntryLite;
  bucket: Bucket;
  reason: string;
  stat?: DirStat;
  git?: GitStat;
  cloneMissing: boolean;
}

export interface PruneSurvey {
  totalEntries: number;
  totalStale: number;
  withPsi: number;
  neverTouch: PruneCandidate[];
  askFirst: PruneCandidate[];
  safe: PruneCandidate[];
}

export interface PruneEnv {
  /** Pre-built manifest (defaults to live `loadManifest()`). */
  manifest?: OracleManifestEntry[];
  /** Cache entries (defaults to live oracles.json). */
  cacheEntries?: OracleEntryLite[];
  /** Process cwd override for PWD self-exclude (defaults to `process.cwd()`). */
  cwd?: string;
  /** Disk stat probe (defaults to fs.statSync + `du -sk`). */
  statDir?: (path: string) => DirStat | null;
  /** Git probe (defaults to `Bun.spawn` git invocations). */
  checkGit?: (path: string) => Promise<GitStat>;
  /** Wall-clock override for deterministic age math in tests. */
  now?: number;
}

export interface CmdPruneStaleOpts {
  yes?: boolean;
  dryRun?: boolean;
  ask?: boolean;
  /** Override oracles.json file location — primarily for tests. */
  cacheFile?: string;
  /** Injectable env for tests (mocks disk + git + manifest). */
  env?: PruneEnv;
  /** Injectable prompt for `--ask` tests. */
  prompt?: (q: string) => Promise<string>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const PLACEHOLDER_KB_MIN = 124;
const PLACEHOLDER_KB_MAX = 128;
const RECENT_DAYS = 8;
const STALE_DAYS = 30;
const CONCURRENCY = 8;

// ─── Cache I/O (preserves unknown top-level keys) ────────────────────────────

export interface OraclesCacheFile {
  raw: Record<string, unknown>;
  entries: OracleEntryLite[];
}

export function oraclesCachePath(): string {
  return mawCachePath("oracles.json");
}

export function legacyOraclesCachePath(): string {
  return mawConfigPath("oracles.json");
}

function readOraclesCacheFile(file: string): OraclesCacheFile | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    const entries = Array.isArray((raw as { oracles?: unknown }).oracles)
      ? ((raw as { oracles: OracleEntryLite[] }).oracles)
      : [];
    return { raw: raw as Record<string, unknown>, entries };
  } catch {
    return null;
  }
}

export function readOraclesCache(file?: string): OraclesCacheFile | null {
  if (file) return readOraclesCacheFile(file);
  return readOraclesCacheFile(oraclesCachePath()) ?? readOraclesCacheFile(legacyOraclesCachePath());
}

export function writeOraclesCache(cache: OraclesCacheFile, file: string = oraclesCachePath()): void {
  const merged = { ...cache.raw, oracles: cache.entries };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

// ─── Default probes ──────────────────────────────────────────────────────────

function defaultStatDir(path: string): DirStat | null {
  try {
    const s = statSync(path);
    if (!s.isDirectory()) return null;
    let sizeBytes = 0;
    try {
      const proc = Bun.spawnSync(["du", "-sk", path]);
      const out = new TextDecoder().decode(proc.stdout).trim();
      const sizeKb = parseInt(out.split(/\s+/)[0] ?? "0", 10);
      if (!Number.isNaN(sizeKb)) sizeBytes = sizeKb * 1024;
    } catch { /* du missing — leave size at 0 */ }
    return { mtimeMs: s.mtimeMs, sizeBytes };
  } catch {
    return null;
  }
}

async function runGit(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    return { ok: proc.exitCode === 0, stdout, stderr };
  } catch {
    return { ok: false, stdout: "", stderr: "git-spawn-failed" };
  }
}

async function defaultCheckGit(path: string): Promise<GitStat> {
  const status = await runGit(["git", "-C", path, "status", "--porcelain"]);
  const porcelain = status.stdout.replace(/\n$/, "");
  const isClean = porcelain.length === 0;
  const uncommitted = isClean ? 0 : porcelain.split("\n").length;

  let unpushed = 0;
  const upstream = await runGit(["git", "-C", path, "rev-parse", "--abbrev-ref", "@{u}"]);
  if (upstream.ok) {
    const rev = await runGit(["git", "-C", path, "rev-list", "--count", "@{u}..HEAD"]);
    if (rev.ok) {
      const n = parseInt(rev.stdout.trim() || "0", 10);
      if (!Number.isNaN(n)) unpushed = n;
    }
  }

  const headRef = await runGit(["git", "-C", path, "symbolic-ref", "-q", "HEAD"]);
  const detached = !headRef.ok;

  let totalCommits = 0;
  const count = await runGit(["git", "-C", path, "rev-list", "--all", "--count"]);
  if (count.ok) {
    const n = parseInt(count.stdout.trim() || "0", 10);
    if (!Number.isNaN(n)) totalCommits = n;
  }

  return { isClean, unpushed, uncommitted, totalCommits, detached };
}

// ─── Bucketing ───────────────────────────────────────────────────────────────

/** True when only the oracles-json source surfaces this entry — no fleet,
 *  no claude session, no agents-map route. */
export function isStaleByManifest(m: OracleManifestEntry): boolean {
  const has = (s: string) => m.sources.includes(s as OracleManifestEntry["sources"][number]);
  return has("oracles-json") && !has("fleet") && !has("session") && !has("agent");
}

export function bucketEntry(
  _entry: OracleEntryLite,
  stat: DirStat | null,
  git: GitStat | null,
  nowMs: number,
): { bucket: Bucket; reason: string; cloneMissing: boolean } {
  // Clone missing — already dead on disk, registry is the only thing left.
  if (!stat) {
    return { bucket: "safe", reason: "clone missing", cloneMissing: true };
  }
  // Git probe blew up — be conservative and never auto-prune.
  if (!git) {
    return { bucket: "never-touch", reason: "git inspect failed", cloneMissing: false };
  }
  // NEVER-TOUCH layer.
  if (git.uncommitted > 0 || git.unpushed > 0 || (git.detached && git.totalCommits > 0)) {
    const parts: string[] = [];
    if (git.unpushed > 0) parts.push(`${git.unpushed} unpushed commit${git.unpushed === 1 ? "" : "s"}`);
    if (git.uncommitted > 0) parts.push(`${git.uncommitted} uncommitted`);
    if (git.detached && git.totalCommits > 0) parts.push("detached HEAD");
    return { bucket: "never-touch", reason: parts.join(", "), cloneMissing: false };
  }
  const sizeKb = Math.round(stat.sizeBytes / 1024);
  // Empty repo — no commits ever made → SAFE.
  if (git.totalCommits === 0) {
    return { bucket: "safe", reason: `empty, ${sizeKb}K`, cloneMissing: false };
  }
  const ageDays = (nowMs - stat.mtimeMs) / DAY_MS;
  // Clean + cold → SAFE.
  if (ageDays >= STALE_DAYS) {
    return {
      bucket: "safe",
      reason: `clean, ${Math.round(ageDays)}d old, ${sizeKb}K`,
      cloneMissing: false,
    };
  }
  // Either recent OR the "intentional placeholder" 124-128 K size band — ASK.
  const looksPlaceholder = sizeKb >= PLACEHOLDER_KB_MIN && sizeKb <= PLACEHOLDER_KB_MAX;
  if (ageDays <= RECENT_DAYS || looksPlaceholder) {
    const reason = looksPlaceholder
      ? `${sizeKb}K, modified ${formatDate(stat.mtimeMs)}`
      : `recent, modified ${formatDate(stat.mtimeMs)}`;
    return { bucket: "ask-first", reason, cloneMissing: false };
  }
  // 8 < ageDays < 30 — clean but neither emphatically fresh nor cold → ASK.
  return {
    bucket: "ask-first",
    reason: `${Math.round(ageDays)}d old, ${sizeKb}K`,
    cloneMissing: false,
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── PWD self-exclude ────────────────────────────────────────────────────────

export function isCwdSelfExclude(localPath: string, cwd: string): boolean {
  if (!localPath) return false;
  const norm = (p: string) => p.replace(/\/+$/, "");
  const lp = norm(localPath);
  const c = norm(cwd);
  if (!lp || !c) return false;
  return lp === c || c === lp || c.startsWith(lp + "/") || lp.startsWith(c + "/");
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Main survey ─────────────────────────────────────────────────────────────

export async function findPruneCandidates(env: PruneEnv = {}): Promise<PruneSurvey> {
  const manifest = env.manifest ?? loadManifest();
  const cacheEntries = env.cacheEntries ?? (readOraclesCache()?.entries ?? []);
  const cwd = env.cwd ?? process.cwd();
  const statDir = env.statDir ?? defaultStatDir;
  const checkGit = env.checkGit ?? defaultCheckGit;
  const nowMs = env.now ?? Date.now();

  const manifestByName = new Map(manifest.map((m) => [m.name, m]));

  let withPsi = 0;
  let totalStale = 0;
  const survivors: OracleEntryLite[] = [];

  for (const entry of cacheEntries) {
    const m = manifestByName.get(entry.name);
    // Every oracles.json entry should appear in the manifest with at least
    // "oracles-json" as a source. If it doesn't, the manifest didn't see it
    // (maw-js workspace not loaded?) — be safe, skip.
    if (!m) continue;
    if (!isStaleByManifest(m)) continue;
    totalStale++;
    if (entry.has_psi) {
      withPsi++;
      continue;
    }
    if (isCwdSelfExclude(entry.local_path ?? "", cwd)) {
      // Operator is standing inside this clone right now — treat the
      // registry record as live regardless of cross-source state.
      continue;
    }
    survivors.push(entry);
  }

  const probes = await mapWithConcurrency(survivors, CONCURRENCY, async (entry) => {
    const stat = entry.local_path ? statDir(entry.local_path) : null;
    let git: GitStat | null = null;
    if (stat) {
      try {
        git = await checkGit(entry.local_path);
      } catch {
        git = null;
      }
    }
    const b = bucketEntry(entry, stat, git, nowMs);
    const c: PruneCandidate = {
      entry,
      bucket: b.bucket,
      reason: b.reason,
      stat: stat ?? undefined,
      git: git ?? undefined,
      cloneMissing: b.cloneMissing,
    };
    return c;
  });

  return {
    totalEntries: cacheEntries.length,
    totalStale,
    withPsi,
    neverTouch: probes.filter((p) => p.bucket === "never-touch"),
    askFirst: probes.filter((p) => p.bucket === "ask-first"),
    safe: probes.filter((p) => p.bucket === "safe"),
  };
}

// ─── Output rendering ────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function renderBucket(
  prefix: string,
  title: string,
  color: string,
  list: PruneCandidate[],
  log: (s: string) => void,
): void {
  if (!list.length) return;
  log("");
  log(`${color}${prefix} ${title} (${list.length})\x1b[0m`);
  for (const c of list) {
    log(`  \x1b[36m${pad(c.entry.name, 22)}\x1b[0m ${c.reason}`);
  }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

export async function cmdPruneStale(opts: CmdPruneStaleOpts = {}): Promise<void> {
  const log = (s: string) => console.log(s);
  const file = opts.cacheFile ?? oraclesCachePath();
  const cache = opts.cacheFile ? readOraclesCache(file) : readOraclesCache();
  if (!cache) {
    log(`\x1b[33mNo oracles.json found at ${file} — nothing to prune.\x1b[0m`);
    return;
  }
  log(`Reading oracles.json (${cache.entries.length} entries)...`);

  const survey = await findPruneCandidates({
    cacheEntries: cache.entries,
    ...(opts.env ?? {}),
  });

  log("");
  log(`Stale candidates (no fleet, no session, no agent): ${survey.totalStale}`);
  log(`  \x1b[90mwith ψ vault (keeping): ${survey.withPsi}\x1b[0m`);
  log(`  \x1b[90mwithout ψ vault (candidates): ${survey.totalStale - survey.withPsi}\x1b[0m`);

  renderBucket("🛑", "NEVER-TOUCH — has unpushed or uncommitted work", "\x1b[31m", survey.neverTouch, log);
  renderBucket("⚠", "ASK-FIRST — recent or suspicious", "\x1b[33m", survey.askFirst, log);
  renderBucket("✅", "SAFE TO PRUNE — empty or old + clean", "\x1b[32m", survey.safe, log);

  // Dry-run / preview path (default and explicit --dry-run).
  if (!opts.yes && !opts.ask) {
    log("");
    if (survey.safe.length === 0 && survey.askFirst.length === 0) {
      log("\x1b[32mNothing to prune.\x1b[0m");
      return;
    }
    if (survey.safe.length > 0) {
      log(
        `Run with \x1b[36m--yes\x1b[0m to prune ${survey.safe.length} ` +
          `SAFE ${survey.safe.length === 1 ? "entry" : "entries"} from oracles.json.`,
      );
    }
    if (survey.askFirst.length > 0) {
      log(`Run with \x1b[36m--ask\x1b[0m to interactively decide on ASK-FIRST.`);
    }
    return;
  }

  // Build the prune set.
  const toPrune = new Set<string>();
  if (opts.yes) {
    for (const c of survey.safe) toPrune.add(c.entry.name);
  }
  if (opts.ask) {
    const prompt = opts.prompt ?? defaultPrompt;
    for (const c of survey.askFirst) {
      const ans = (await prompt(`Prune ${c.entry.name} (${c.reason})? [y/N] `)).trim().toLowerCase();
      if (ans === "y" || ans === "yes") toPrune.add(c.entry.name);
    }
  }

  if (toPrune.size === 0) {
    log("\n\x1b[90mNothing selected for pruning.\x1b[0m");
    return;
  }

  // Abort window before write — mirrors the team-cleanup-zombies idiom (PR #43).
  // Skipped in MAW_TEST_MODE so test runs stay deterministic.
  if (opts.yes && !process.env.MAW_TEST_MODE) {
    log(`\n\x1b[33m! Pruning in 3s — Ctrl-C to abort.\x1b[0m`);
    for (let i = 3; i > 0; i--) {
      process.stdout.write(`  \x1b[90m${i}...\x1b[0m\r`);
      await Bun.sleep(1000);
    }
    process.stdout.write(`        \r`); // clear countdown line
  }

  log(`\x1b[36mPruning ${toPrune.size} ${toPrune.size === 1 ? "entry" : "entries"}...\x1b[0m`);
  const remaining = cache.entries.filter((e) => !toPrune.has(e.name));
  writeOraclesCache({ raw: cache.raw, entries: remaining }, file);
  log(
    `\x1b[32m✓\x1b[0m wrote oracles.json (${remaining.length} entries remain, ` +
      `${toPrune.size} pruned)`,
  );
}

async function defaultPrompt(q: string): Promise<string> {
  const { createInterface } = await import("readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}
