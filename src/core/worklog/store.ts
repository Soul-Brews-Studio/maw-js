/**
 * Worklog durable store — append-only JSONL, one file per company at
 * `<mawData>/companies/<company>/worklog.jsonl` (Company Home, ADR 0001 §6).
 *
 * Track 2 cutover: the file moved from the old `<mawData>/worklog/<c>.jsonl`.
 * Migration is automatic, idempotent, and zero-loss — see ensureWorklogMigrated.
 *
 * WRITERS ARE MULTIPLE (not single): the server feed listener, the `maw company worklog
 * claim/release` CLI, and the `maw done` → PR poller all append the same
 * <company>.jsonl, across processes. Append safety = each entry is serialized to
 * a single line whose byte length is bounded (MAX_LINE_BYTES below), keeping each
 * append a single small write() under O_APPEND. NOTE (kobo-463, %5 c10): PIPE_BUF
 * is a pipe/FIFO guarantee, not a regular-file one — citing it here overstated the
 * assurance. What actually held, measured directly (kobo-463 c9: two real
 * concurrent writer processes, 8000 appends, 0 torn tails observed across 2187
 * reads), is a practical property of local writes this size, not a POSIX contract
 * — a bounded negative, not a proof. (Honours "Nothing is Deleted": entries are
 * only appended; read still skips any malformed line as a last-ditch guard.)
 *
 * The server feed listener is on the hot path, so it uses the non-blocking
 * `appendWorklogAsync` (ordered per-file queue); CLI/poller use the sync variant.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, statSync, openSync, readSync, closeSync } from "fs";
import { appendFile as appendFileP, mkdir as mkdirP } from "fs/promises";
import { dirname } from "path";
import { mawDataPath } from "../xdg";
import type { WorklogEntry } from "./types";

const DEFAULT_COMPANY = "_unscoped";
const MAX_LINE_BYTES = 3072; // small single write() per append (kobo-463 c10 — not a PIPE_BUF/POSIX guarantee, see file header)

function safeCompany(company?: string | null): string {
  const c = (company ?? DEFAULT_COMPANY).trim() || DEFAULT_COMPANY;
  return c.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Current home — beside tasks/, state.md, policy/ (ADR 0001 §6). */
export function worklogPath(company?: string | null): string {
  return mawDataPath("companies", safeCompany(company), "worklog.jsonl");
}

/** Pre-Track-2 location — kept only for the one-time migration + read fallback. */
function legacyWorklogPath(company?: string | null): string {
  return mawDataPath("worklog", `${safeCompany(company)}.jsonl`);
}

// Per-process memo so the hot append path doesn't stat the fs on every event.
const migrated = new Set<string>();

/**
 * One-time, idempotent migration to the Company Home. If the new file is missing
 * but the legacy one exists, rename it across — both live under ~/.maw (one
 * filesystem), so the move is atomic + instant and any fd already open on the
 * file follows it → not a single event lost, even mid-append.
 *
 * Concurrency is safe: the legacy file can be renamed successfully only once (it
 * vanishes on the first move), so the new file is never clobbered by a second
 * racer — the loser hits ENOENT and is ignored. If the rename can't run at all
 * (e.g. read-only fs), readWorklog's fallback still finds the data at the old
 * path, so nothing disappears.
 */
function ensureWorklogMigrated(company?: string | null): void {
  const key = safeCompany(company);
  if (migrated.has(key)) return;
  const np = worklogPath(company);
  if (existsSync(np)) { migrated.add(key); return; } // already moved (or fresh)
  const op = legacyWorklogPath(company);
  if (existsSync(op)) {
    try {
      mkdirSync(dirname(np), { recursive: true });
      renameSync(op, np); // atomic in-fs move; open fds follow it
    } catch {
      /* lost the rename race (ENOENT) or fs refused — read-fallback covers it */
    }
  }
  migrated.add(key);
}

/** Test-only — clear the per-process migration memo (data dir varies in tests). */
export function _resetWorklogMigrationMemo(): void {
  migrated.clear();
}

/** Serialize one entry to a single line, bounded so the append stays atomic. */
function serializeLine(entry: WorklogEntry): string {
  let line = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  // too big — shrink the only unbounded field (summary) until it fits
  let summary = entry.summary;
  while (summary.length > 8 && Buffer.byteLength(line) > MAX_LINE_BYTES) {
    summary = summary.slice(0, Math.max(8, Math.floor(summary.length * 0.8)));
    line = JSON.stringify({ ...entry, summary: summary + "…" }) + "\n";
  }
  return line;
}

/** Append one entry synchronously (CLI / poller). */
export function appendWorklog(entry: WorklogEntry): void {
  ensureWorklogMigrated(entry.company);
  const p = worklogPath(entry.company);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, serializeLine(entry));
}

// Non-blocking ordered append for the hot feed-listener path. Per-file promise
// chains preserve order without serializing the caller on fsync.
const chains = new Map<string, Promise<void>>();

/** Append one entry without blocking the caller (server feed listener). */
export function appendWorklogAsync(entry: WorklogEntry): void {
  ensureWorklogMigrated(entry.company); // sync + memoized → migrates before the first queued append
  const p = worklogPath(entry.company);
  const line = serializeLine(entry);
  const prev = chains.get(p) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await mkdirP(dirname(p), { recursive: true });
      await appendFileP(p, line);
    })
    .catch(() => { /* never break the feed pipeline */ });
  chains.set(p, next);
}

/** Await all pending async appends (tests / graceful shutdown). */
export async function flushWorklog(): Promise<void> {
  await Promise.all([...chains.values()]);
}

export interface ReadWorklogOpts {
  limit?: number;
  since?: number;
  oracle?: string;
  kinds?: WorklogEntry["kind"][];
  excludeKinds?: WorklogEntry["kind"][]; // drop these BEFORE limit (kobo-109: keep idle out
  //                                        of the inject window so real events aren't starved)
}

function parseWorklogLines(text: string): WorklogEntry[] {
  const out: WorklogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as WorklogEntry);
    } catch {
      /* last-ditch guard — bounded atomic appends should prevent this */
    }
  }
  return out;
}

/** Read exactly [start, start+length) from a file without loading the rest. */
function readBytesFrom(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

interface WorklogCacheEntry {
  size: number;
  entries: WorklogEntry[]; // raw, unfiltered — every caller filters its own opts after
}

// Keyed by resolved path (kobo-463): one slot per company's worklog file, not
// one slot shared across companies. Append-only file ⇒ size only grows unless
// truncated/rotated, so an unchanged size proves unchanged content (kobo-402
// worklogCacheProbe's premise) and a shrunk size means don't trust the cache.
//
// Freshness is judged by SIZE ALONE, not mtime/hash/content — deliberate, not
// an oversight. That's only safe because this file is append-only (see file
// header: writers only ever appendFileSync/appendFile, never rewrite in
// place). An in-place edit that kept the byte count identical would be served
// stale forever; there is no such writer today, but if one is ever added,
// this cache breaks silently.
const worklogCache = new Map<string, WorklogCacheEntry>();

/** Test-only — clear the read cache (kobo-463, data dir varies in tests). */
export function _resetWorklogCache(): void {
  worklogCache.clear();
}

/** TEST-ONLY, READ-ONLY (kobo-463). Peeks the cache's recorded byte offset for a path so a
 * test can assert it against the file's real stat size directly — the actual invariant a
 * char-based offset bug (kobo-463 c7/c8) silently broke, more reliable than asserting on an
 * emergent symptom (duplication depends on where the drift lands relative to JSON structure).
 * DELIBERATELY has no counterpart setter: this must never become a way to mutate the cache,
 * only to observe it, in test or otherwise. Do not add one. */
export function _worklogCacheSize(path: string): number | undefined {
  return worklogCache.get(path)?.size;
}

export function readWorklog(company: string | null | undefined, opts: ReadWorklogOpts = {}): WorklogEntry[] {
  const { path, size } = worklogCacheProbe(company);
  const cached = worklogCache.get(path);

  let entries: WorklogEntry[];
  if (cached && size === cached.size) {
    entries = cached.entries; // unchanged — skip the read+parse entirely
  } else if (cached && size > cached.size) {
    // grew — the log is append-only, so only the new tail needs reading.
    //
    // ALL-OR-NOTHING (kobo-463, %11 c9 — supersedes an earlier per-line-offset
    // version that computed a BYTE position from a CHARACTER index and drifted
    // silently on Thai content, kobo-463 c7/c8): a read can land mid-append and
    // catch a half-written trailing line. Rather than finding the last complete
    // newline and consuming up to there (offset arithmetic — the exact class of
    // bug that bit this file once already), only consume the tail AT ALL when
    // it ends in a newline. cached.size then becomes exactly `size` — the real
    // stat size, not a computed offset — so there is no byte/character position
    // to get wrong. If the tail doesn't end in a newline, consume nothing this
    // round; the whole tail (including any complete lines in front of the torn
    // one) is picked up together once it does.
    const rawTail = readBytesFrom(path, cached.size, size - cached.size);
    if (rawTail.endsWith("\n")) {
      entries = cached.entries.concat(parseWorklogLines(rawTail));
      worklogCache.set(path, { size, entries });
    } else {
      entries = cached.entries; // incomplete trailing line — consume nothing, don't advance
    }
  } else {
    // no cache yet, OR size shrank (truncate/rotate) — the past cache can't be
    // trusted, re-read the whole file
    entries = size > 0 ? parseWorklogLines(readFileSync(path, "utf-8")) : [];
    worklogCache.set(path, { size, entries });
  }

  let filtered = entries;
  if (opts.since != null) filtered = filtered.filter(e => e.ts >= opts.since!);
  if (opts.oracle) filtered = filtered.filter(e => e.oracle === opts.oracle);
  if (opts.kinds) filtered = filtered.filter(e => opts.kinds!.includes(e.kind));
  if (opts.excludeKinds) filtered = filtered.filter(e => !opts.excludeKinds!.includes(e.kind));
  if (opts.limit != null && filtered.length > opts.limit) filtered = filtered.slice(-opts.limit);
  // filter()/slice() above already copy — but when no opts match, filtered
  // still aliases the cached array; a caller mutating the result would
  // corrupt every future reader (kobo-463, %5's find).
  return filtered === entries ? filtered.slice() : filtered;
}

/**
 * Cheap freshness probe for a derived-from-worklog cache (kobo-402), WITHOUT
 * reading the file's contents: resolves the same path readWorklog would use
 * (post-migration, legacy fallback) and its current byte size. Multiple
 * processes append this file (server feed listener, CLI, PR poller — see file
 * header), so a derived cache can't rely on in-process write events alone;
 * callers key their cache by `path` and treat an unchanged `size` as proof the
 * content hasn't changed (the log is append-only, so size only grows) —
 * skipping a full read+parse when nothing changed since the last one.
 */
export function worklogCacheProbe(company: string | null | undefined): { path: string; size: number } {
  ensureWorklogMigrated(company);
  let p = worklogPath(company);
  if (!existsSync(p)) {
    const legacy = legacyWorklogPath(company);
    if (existsSync(legacy)) p = legacy;
  }
  let size = 0;
  try { size = statSync(p).size; } catch { /* not created yet */ }
  return { path: p, size };
}

/** Open claims for a company — claims with no later matching claim-release. */
export function openClaims(company: string | null | undefined): WorklogEntry[] {
  const all = readWorklog(company, { kinds: ["claim", "claim-release"] });
  const released = new Set<string>();
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.kind === "claim-release") released.add(`${e.oracle}::${e.task ?? e.summary}`);
  }
  const open: WorklogEntry[] = [];
  const seen = new Set<string>();
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.kind !== "claim") continue;
    const key = `${e.oracle}::${e.task ?? e.summary}`;
    if (seen.has(key) || released.has(key)) continue;
    seen.add(key);
    open.push(e);
  }
  return open.reverse();
}
