/**
 * maw peers — storage layer (#568, #572).
 *
 * Atomic read/write of `~/.maw/peers.json`. Writes go via a temp file
 * and rename(2) so a crash mid-write leaves either the old file intact
 * or the new file fully in place — never a truncated file. A stale tmp
 * file from a crashed previous write is cleaned on load (the live file
 * is still valid; the tmp is leftover from a crashed writer).
 *
 * Schema v1:
 *   { version: 1, peers: { <alias>: { url, node, addedAt, lastSeen,
 *                                     [lastError, nickname, pubkey, pubkeyFirstSeen,
 *                                      identity] } } }
 *   — fields in brackets are optional. `pubkey` / `pubkeyFirstSeen` were
 *   added in #804 Step 2 for TOFU peer-identity pinning. `identity` was
 *   added in #804 Step 3 to capture the peer's self-reported `<oracle>:<node>`
 *   pair for duplicate-detection (doctor + boot-time warn).
 *
 * Path resolution is a function (not a const) so tests can override
 * `HOME` / the path via `PEERS_FILE` and get a fresh value each call.
 *
 * Concurrency: savePeers takes a short-lived file lock around the
 * read-modify-write critical section so concurrent `maw peers add`
 * calls don't lose each other's updates (#572 nit 3). See ./lock.ts.
 *
 * Corruption: if the live file fails to parse, OR if it parses but
 * the shape is wrong (e.g. `{"peers":[]}` — array instead of object),
 * we rename it aside to `peers.json.corrupt-<ISO>` and start fresh —
 * non-destructive, with an audit trail (#572 nit 1, follow-up to #579).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { withPeersLock } from "./lock";

/**
 * Structured last-probe failure — opt-in field on Peer (#565).
 *
 * Absent (undefined) means either the peer has never been probed, or
 * the most recent probe succeeded. Readers that don't know about this
 * field continue to work — schema v1 is unchanged.
 */
export interface LastError {
  /** Classified code — see probe.ts classifyProbeError(). */
  code: "DNS" | "REFUSED" | "TIMEOUT" | "TLS" | "HTTP_4XX" | "HTTP_5XX" | "BAD_BODY" | "UNKNOWN";
  /** Raw error message (from err.message or synthesized for HTTP cases). */
  message: string;
  /** ISO timestamp when the failure was recorded. */
  at: string;
}

export interface Peer {
  url: string;
  node: string | null;
  addedAt: string;
  lastSeen: string | null;
  /** Optional — set by probePeer() when handshake fails; cleared on success. */
  lastError?: LastError;
  /** Optional human-friendly nickname, propagated from peer's /info (#643 Phase 2). */
  nickname?: string | null;
  /**
   * TOFU-cached pubkey from the peer's /api/identity response (#804 Step 2).
   *
   * Absent until the first successful identity fetch that returned a `pubkey`
   * field. Once cached, every subsequent identity check validates the response
   * against this value — mismatch is treated as either rotation or
   * impersonation and is refused (see ADR docs/federation/0001-peer-identity.md
   * O6 table). Operator clears via `maw peers forget <alias>` to re-TOFU.
   */
  pubkey?: string;
  /** ISO timestamp when the pubkey was first cached (TOFU). */
  pubkeyFirstSeen?: string;
  /**
   * Peer's self-reported `<oracle>:<node>` pair from /api/identity (#804 Step 3).
   *
   * Captured opportunistically alongside `pubkey` during TOFU bootstrap and on
   * every subsequent successful probe. Drives the duplicate-detection check
   * in `maw doctor` and the boot-time warning in `maw serve` — two peers
   * claiming the same `<oracle>:<node>` is operator confusion that crypto
   * (Step 2) cannot solve, and operator must investigate.
   *
   * Absent for legacy peers (pre-Step-1 nodes that don't expose /api/identity)
   * and for peers whose /api/identity response omitted both `node` and `oracle`.
   * Doctor + boot-warn skip undefined identity (no false-positive collision).
   */
  identity?: { oracle: string; node: string };
}

export interface PeersFile {
  version: 1;
  peers: Record<string, Peer>;
}

export function peersPath(): string {
  return process.env.PEERS_FILE || join(homedir(), ".maw", "peers.json");
}

export function emptyStore(): PeersFile {
  return { version: 1, peers: {} };
}

export function loadPeers(): PeersFile {
  clearStaleTmp();
  const path = peersPath();
  if (!existsSync(path)) return emptyStore();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PeersFile>;
    if (!isValidStoreShape(parsed)) throw new Error("invalid store shape (expected { peers: { ... } } object)");
    return {
      version: 1,
      peers: (parsed.peers ?? {}) as Record<string, Peer>,
    };
  } catch (e: any) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = `${path}.corrupt-${stamp}`;
    try { renameSync(path, aside); } catch { /* ignore — caller still gets empty store */ }
    console.error(`\x1b[33m⚠\x1b[0m peers store at ${path} failed to parse (${e?.message || e}); moved aside to ${aside}`);
    return emptyStore();
  }
}

/**
 * Validate the parsed JSON matches the expected store shape:
 * a non-null object whose `peers` field is itself a non-null,
 * non-array object. Guards against `{"peers":[]}` (array) and
 * other junk that would silently no-op every write (follow-up
 * to #579).
 */
function isValidStoreShape(parsed: unknown): parsed is PeersFile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const peers = (parsed as { peers?: unknown }).peers;
  if (peers === undefined) return true; // missing peers is ok — we default to {}
  return typeof peers === "object" && peers !== null && !Array.isArray(peers);
}

export function savePeers(data: PeersFile): void {
  const path = peersPath();
  mkdirSync(dirname(path), { recursive: true });
  withPeersLock(path, () => writeAtomic(path, data));
}

/**
 * Atomic read-modify-write under the peers lock. Use this whenever a
 * mutation depends on current contents (add/remove) — it re-reads
 * inside the lock so concurrent writers don't lose each other's
 * updates. The mutator runs synchronously inside the critical section.
 */
export function mutatePeers(mutate: (data: PeersFile) => void): PeersFile {
  const path = peersPath();
  mkdirSync(dirname(path), { recursive: true });
  return withPeersLock(path, () => {
    const fresh = readUnlocked(path);
    mutate(fresh);
    writeAtomic(path, fresh);
    return fresh;
  });
}

/** Read + parse without taking the lock or doing corruption-handling rename. */
function readUnlocked(path: string): PeersFile {
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<PeersFile>;
    if (!isValidStoreShape(parsed)) return emptyStore();
    return {
      version: 1,
      peers: (parsed.peers ?? {}) as Record<string, Peer>,
    };
  } catch {
    return emptyStore();
  }
}

function writeAtomic(path: string, data: PeersFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Best-effort cleanup of a stale tmp file (ignore errors). */
export function clearStaleTmp(): void {
  const tmp = `${peersPath()}.tmp`;
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
}
