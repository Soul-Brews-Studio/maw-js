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
 *   { version: 1, peers: { <alias>: { url, node, addedAt, lastSeen } } }
 *
 * Path resolution is a function (not a const) so tests can override
 * `HOME` / the path via `PEERS_FILE` and get a fresh value each call.
 *
 * Concurrency: savePeers takes a short-lived file lock around the
 * read-modify-write critical section so concurrent `maw peers add`
 * calls don't lose each other's updates (#572 nit 3). See ./lock.ts.
 *
 * Corruption: if the live file fails to parse, we rename it aside to
 * `peers.json.corrupt-<ISO>` and start fresh — non-destructive, with
 * an audit trail (#572 nit 1).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { withPeersLock } from "./lock";

export interface Peer {
  url: string;
  node: string | null;
  addedAt: string;
  lastSeen: string | null;
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
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      version: 1,
      peers: parsed.peers && typeof parsed.peers === "object" ? parsed.peers : {},
    };
  } catch (e: any) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = `${path}.corrupt-${stamp}`;
    try { renameSync(path, aside); } catch { /* ignore — caller still gets empty store */ }
    console.error(`\x1b[33m⚠\x1b[0m peers store at ${path} failed to parse (${e?.message || e}); moved aside to ${aside}`);
    return emptyStore();
  }
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
    if (!parsed || typeof parsed !== "object") return emptyStore();
    return {
      version: 1,
      peers: parsed.peers && typeof parsed.peers === "object" ? parsed.peers : {},
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
