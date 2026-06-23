/**
 * Worklog durable store — append-only JSONL, one file per company at
 * `<mawData>/worklog/<company>.jsonl`.
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

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
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

export function worklogPath(company?: string | null): string {
  return mawDataPath("worklog", `${safeCompany(company)}.jsonl`);
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
  const p = worklogPath(entry.company);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, serializeLine(entry));
}

// Non-blocking ordered append for the hot feed-listener path. Per-file promise
// chains preserve order without serializing the caller on fsync.
const chains = new Map<string, Promise<void>>();

/** Append one entry without blocking the caller (server feed listener). */
export function appendWorklogAsync(entry: WorklogEntry): void {
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
  const p = worklogPath(company);
  if (!existsSync(p)) return [];
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
