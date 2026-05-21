/**
 * Read-only peer alias resolution for `maw ls <peer>` and `maw ls --all`.
 *
 * Mirrors plugins/wake/internal/peer-resolve.ts in shape — reads the same
 * maw state `peers.json` store managed by `maw peers add/list/rm`. Adds
 * `resolveAllPeers()` for the `--all` aggregation path. Path resolution
 * is a function (not a const) so tests can override via `PEERS_FILE`.
 *
 * Kept minimal on purpose — no atomic writes, no locking. The full store
 * impl in `src/lib/peers/store.ts` adds those for the write path; nothing
 * here needs them for a read-only URL lookup at dispatch time.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { mawStatePath } from "../../../../core/xdg";

export interface ResolvedPeer {
  alias: string;
  url: string;
  node: string | null;
}

function peersPath(): string {
  return process.env.PEERS_FILE || mawStatePath("peers.json");
}

function legacyPeersPath(): string | null {
  if (process.env.PEERS_FILE || process.env.MAW_HOME) return null;
  const legacy = join(process.env.HOME || homedir(), ".maw", "peers.json");
  return legacy === peersPath() ? null : legacy;
}

function readablePeersPath(): string {
  const primary = peersPath();
  if (existsSync(primary)) return primary;
  const legacy = legacyPeersPath();
  return legacy && existsSync(legacy) ? legacy : primary;
}

function readPeers(): Record<string, { url?: string; node?: string }> | null {
  const path = readablePeersPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed?.peers && typeof parsed.peers === "object" ? parsed.peers : null;
  } catch {
    return null;
  }
}

export function resolvePeer(alias: string): ResolvedPeer | null {
  const peers = readPeers();
  if (!peers) return null;
  const peer = peers[alias];
  if (!peer || typeof peer.url !== "string") return null;
  return { alias, url: peer.url, node: typeof peer.node === "string" ? peer.node : null };
}

export function resolveAllPeers(): ResolvedPeer[] {
  const peers = readPeers();
  if (!peers) return [];
  return Object.entries(peers)
    .filter(([, v]) => v && typeof v.url === "string")
    .map(([alias, v]) => ({
      alias,
      url: v.url as string,
      node: typeof v.node === "string" ? v.node : null,
    }));
}
