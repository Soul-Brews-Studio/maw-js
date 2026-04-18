/**
 * maw peers — storage layer (#568).
 *
 * Atomic read/write of `~/.maw/peers.json`. Writes go via a temp file
 * and rename(2) so a crash mid-write leaves either the old file intact
 * or the new file fully in place — never a truncated file. A stale tmp
 * file from a crashed previous write is ignored on load (the live file
 * is still valid).
 *
 * Schema v1:
 *   { version: 1, peers: { <alias>: { url, node, addedAt, lastSeen } } }
 *
 * Path resolution is a function (not a const) so tests can override
 * `HOME` / the path via `PEERS_FILE` and get a fresh value each call.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

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
  const path = peersPath();
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

export function savePeers(data: PeersFile): void {
  const path = peersPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Best-effort cleanup of a stale tmp file (ignore errors). */
export function clearStaleTmp(): void {
  const tmp = `${peersPath()}.tmp`;
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
}
