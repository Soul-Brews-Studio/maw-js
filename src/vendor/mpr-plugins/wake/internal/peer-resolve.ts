/**
 * Read-only peer alias resolution for `maw wake --peer <alias>`.
 *
 * Looks up the URL for a peer alias in the maw state `peers.json` store
 * managed by the `maw peers` plugin. Returns null when the
 * alias is unknown, the store file is missing, or the file is unreadable —
 * the caller surfaces an error with the alias name so the operator can
 * `maw peers add` and retry. Path resolution is a function (not a const)
 * so tests can override via `PEERS_FILE`.
 *
 * Kept minimal on purpose — the full `peers/store.ts` adds atomic writes,
 * locking, and corruption recovery. None of that is needed for a read-only
 * URL lookup at dispatch time.
 */
import { readFileSync, existsSync } from "fs";
import { legacyMawPath, mawStatePath } from "../../../../core/xdg";

export interface ResolvedPeer {
  url: string;
  node: string | null;
}

function peersPath(): string {
  return process.env.PEERS_FILE || mawStatePath("peers.json");
}

function legacyPeersPath(): string | null {
  if (process.env.PEERS_FILE || process.env.MAW_HOME) return null;
  const legacy = legacyMawPath("peers.json");
  return legacy === peersPath() ? null : legacy;
}

function readablePeersPath(): string {
  const primary = peersPath();
  if (existsSync(primary)) return primary;
  const legacy = legacyPeersPath();
  return legacy && existsSync(legacy) ? legacy : primary;
}

export function resolvePeer(alias: string): ResolvedPeer | null {
  const path = readablePeersPath();
  if (!existsSync(path)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  const peer = parsed?.peers?.[alias];
  if (!peer || typeof peer.url !== "string") return null;
  return { url: peer.url, node: typeof peer.node === "string" ? peer.node : null };
}
