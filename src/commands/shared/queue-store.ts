/**
 * queue-store.ts — pending approval-queue storage (#842 Sub-C).
 *
 * Phase 2 of #642: when `evaluateAcl(sender, target, ...)` returns "queue",
 * the message must be persisted on disk so a human operator can review and
 * approve / reject it later via `maw inbox`.
 *
 * Storage layout — one JSON file per pending message:
 *
 *   <CONFIG_DIR>/pending/<timestamp>-<random>.json
 *
 * Each file holds a {@link PendingMessage} record. The file-per-message
 * shape mirrors the scope plugin (#829) — disjoint files mean concurrent
 * writes don't race, corruption blasts at most one entry, and a future
 * `maw inbox edit` can be a plain text edit.
 *
 * TTL: messages are valid for {@link TTL_MS} ms (30 days). Expiry is
 * lazy — we delete stale files at read time rather than running a cron.
 * That keeps the data-plane simple (no daemon, no scheduler) at the cost
 * of an O(n) walk on each `loadPending()`. n is small in practice (queue
 * is human-paced), so the trade is fine.
 *
 * Atomic writes: tmp + rename(2), same trick as scope/peers/trust stores.
 *
 * Pure-ish: depends only on `fs` + `os`. No business logic — that lives
 * in `inbox/impl.ts` which composes this store with the comm-send hot
 * path. Sub-A/Sub-B kept their primitives equally surgical.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * On-disk pending message. Status starts at "pending" — `cmdApprove` /
 * `cmdReject` flip it. `id` is the filename (sans `.json`) so the CLI
 * can take a short id and resolve it back to the file with a single
 * `pendingPath(id)` call.
 */
export interface PendingMessage {
  id: string;
  sender: string;
  target: string;
  message: string;
  sentAt: string;
  status: "pending" | "approved" | "rejected";
  /** Original raw query (e.g. "mba:hojo") used by `cmdApprove` to re-issue the send via comm-send. */
  query?: string;
}

/** TTL for a pending message — 30 days. Messages older than this are
 *  silently removed on the next `loadPending()` call. */
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the active config dir at call time so tests can point the
 * directory at a temp path per-test by setting `MAW_CONFIG_DIR` /
 * `MAW_HOME` in beforeEach. Mirrors `scope/impl.ts::activeConfigDir`
 * and `trust/store.ts::activeConfigDir`.
 */
function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function pendingDir(): string {
  return join(activeConfigDir(), "pending");
}

export function pendingPath(id: string): string {
  return join(pendingDir(), `${id}.json`);
}

function ensurePendingDir(): void {
  mkdirSync(pendingDir(), { recursive: true });
}

/**
 * Generate a fresh queue id. ISO timestamp (filesystem-safe) + 6 random
 * hex chars. Two-tier so chronological sort is meaningful AND collisions
 * are vanishingly unlikely even when two writers fire in the same
 * millisecond.
 */
export function newPendingId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${ts}-${rand}`;
}

/**
 * Persist a new pending message. Returns the on-disk record (with id
 * + sentAt populated). Atomic write via tmp + rename.
 */
export function savePending(input: {
  sender: string;
  target: string;
  message: string;
  query?: string;
}): PendingMessage {
  ensurePendingDir();
  const now = new Date();
  const id = newPendingId(now);
  const record: PendingMessage = {
    id,
    sender: input.sender,
    target: input.target,
    message: input.message,
    sentAt: now.toISOString(),
    status: "pending",
    query: input.query,
  };
  const path = pendingPath(id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
  return record;
}

/**
 * Update an existing pending record in place — used by approve/reject
 * to flip `status`. Atomic write. Returns the updated record. Throws
 * if the id doesn't exist on disk.
 */
export function updatePending(id: string, patch: Partial<PendingMessage>): PendingMessage {
  const path = pendingPath(id);
  if (!existsSync(path)) {
    throw new Error(`pending message not found: ${id}`);
  }
  const current = JSON.parse(readFileSync(path, "utf-8")) as PendingMessage;
  const merged: PendingMessage = { ...current, ...patch, id: current.id };
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  renameSync(tmp, path);
  return merged;
}

/**
 * Load a single pending message by id. Returns `null` if missing,
 * malformed, or expired (older than {@link TTL_MS}). Expired files are
 * deleted as a side effect — lazy GC.
 */
export function loadPendingById(id: string): PendingMessage | null {
  const path = pendingPath(id);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: PendingMessage;
  try {
    parsed = JSON.parse(raw) as PendingMessage;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.id !== "string") return null;
  if (isExpired(parsed)) {
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  return parsed;
}

/**
 * Load all pending messages, oldest first. Side effect: deletes
 * expired files (older than {@link TTL_MS}). Returns `[]` if the
 * pending dir is missing or unreadable — same forgiving semantics as
 * the trust + scope loaders.
 */
export function loadPending(): PendingMessage[] {
  const dir = pendingDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PendingMessage[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as PendingMessage;
      if (!parsed || typeof parsed.id !== "string") continue;
      if (isExpired(parsed)) {
        try { unlinkSync(path); } catch { /* ignore */ }
        continue;
      }
      out.push(parsed);
    } catch {
      // Skip corrupt files — operator may hand-edit, don't sink the whole list.
    }
  }
  // Oldest first — sort by sentAt, fall back to id (lexicographic).
  out.sort((a, b) => {
    const at = a.sentAt || a.id;
    const bt = b.sentAt || b.id;
    return at.localeCompare(bt);
  });
  return out;
}

/** Delete a pending message file. Returns `true` if the file existed. */
export function deletePending(id: string): boolean {
  const path = pendingPath(id);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True if the message's `sentAt` is older than {@link TTL_MS} ago. */
export function isExpired(msg: PendingMessage, now: Date = new Date()): boolean {
  const sent = Date.parse(msg.sentAt || "");
  if (!Number.isFinite(sent)) return false; // unparseable → don't reap
  return now.getTime() - sent > TTL_MS;
}
