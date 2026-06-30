/**
 * Worklog durable store — append-only JSONL, one file per company at
 * `<mawData>/companies/<company>/worklog.jsonl` (Company Home, ADR 0001 §6).
 *
 * Track 2 cutover: the file moved from the old `<mawData>/worklog/<c>.jsonl`.
 * Migration is automatic, idempotent, and zero-loss — see ensureWorklogMigrated.
 *
 * WRITERS ARE MULTIPLE (not single): the server feed listener, the `maw watch
 * claim/release` CLI, and the `maw done` → PR poller all append the same
 * <company>.jsonl, across processes. Append safety = each entry is serialized to
 * a single line whose byte length is bounded < PIPE_BUF (4 KB), so the O_APPEND
 * write is atomic per POSIX → lines never interleave/corrupt. (Honours "Nothing
 * is Deleted": entries are only appended; read still skips any malformed line as
 * a last-ditch guard.)
 *
 * The server feed listener is on the hot path, so it uses the non-blocking
 * `appendWorklogAsync` (ordered per-file queue); CLI/poller use the sync variant.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFile as appendFileP, mkdir as mkdirP } from "fs/promises";
import { dirname } from "path";
import { mawDataPath } from "../xdg";
import type { WorklogEntry } from "./types";

const DEFAULT_COMPANY = "_unscoped";
const MAX_LINE_BYTES = 3072; // < PIPE_BUF (4096) → atomic O_APPEND, no interleave

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
}

export function readWorklog(company: string | null | undefined, opts: ReadWorklogOpts = {}): WorklogEntry[] {
  ensureWorklogMigrated(company);
  let p = worklogPath(company);
  if (!existsSync(p)) {
    // read-fallback — covers the transition window / a migration that couldn't write
    const legacy = legacyWorklogPath(company);
    if (!existsSync(legacy)) return [];
    p = legacy;
  }
  let entries: WorklogEntry[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WorklogEntry);
    } catch {
      /* last-ditch guard — bounded atomic appends should prevent this */
    }
  }
  if (opts.since != null) entries = entries.filter(e => e.ts >= opts.since!);
  if (opts.oracle) entries = entries.filter(e => e.oracle === opts.oracle);
  if (opts.kinds) entries = entries.filter(e => opts.kinds!.includes(e.kind));
  if (opts.limit != null && entries.length > opts.limit) entries = entries.slice(-opts.limit);
  return entries;
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
