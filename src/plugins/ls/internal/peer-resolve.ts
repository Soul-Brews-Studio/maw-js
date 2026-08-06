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
import { legacyMawPath, mawStatePath } from "../../../../core/xdg";

export interface ResolvedPeer {
  alias: string;
  url: string;
  node: string | null;
  sshAlias?: string;
  sshHost?: string;
  sshUser?: string;
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

type RawPeer = {
  url?: string;
  node?: string;
  sshAlias?: string;
  ssh?: string | { alias?: string; target?: string; host?: string; user?: string };
  sshHost?: string;
  sshUser?: string;
  user?: string;
};

function readPeers(): Record<string, RawPeer> | null {
  const path = readablePeersPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed?.peers && typeof parsed.peers === "object" ? parsed.peers : null;
  } catch {
    return null;
  }
}

function sshAliasFrom(peer: RawPeer): string | undefined {
  if (typeof peer.sshAlias === "string" && peer.sshAlias.trim()) return peer.sshAlias.trim();
  if (typeof peer.ssh === "string" && peer.ssh.trim()) return peer.ssh.trim();
  if (peer.ssh && typeof peer.ssh === "object") {
    const target = peer.ssh.target ?? peer.ssh.alias;
    if (typeof target === "string" && target.trim()) return target.trim();
  }
  return undefined;
}

function sshHostFrom(peer: RawPeer): string | undefined {
  if (typeof peer.sshHost === "string" && peer.sshHost.trim()) return peer.sshHost.trim();
  if (peer.ssh && typeof peer.ssh === "object" && typeof peer.ssh.host === "string" && peer.ssh.host.trim()) {
    return peer.ssh.host.trim();
  }
  return undefined;
}

function sshUserFrom(peer: RawPeer): string | undefined {
  if (typeof peer.sshUser === "string" && peer.sshUser.trim()) return peer.sshUser.trim();
  if (typeof peer.user === "string" && peer.user.trim()) return peer.user.trim();
  if (peer.ssh && typeof peer.ssh === "object" && typeof peer.ssh.user === "string" && peer.ssh.user.trim()) {
    return peer.ssh.user.trim();
  }
  return undefined;
}

export function resolvePeer(alias: string): ResolvedPeer | null {
  const peers = readPeers();
  if (!peers) return null;
  const peer = peers[alias];
  if (!peer || typeof peer.url !== "string") return null;
  const sshAlias = sshAliasFrom(peer);
  const sshHost = sshHostFrom(peer);
  const sshUser = sshUserFrom(peer);
  return {
    alias,
    url: peer.url,
    node: typeof peer.node === "string" ? peer.node : null,
    ...(sshAlias ? { sshAlias } : {}),
    ...(sshHost ? { sshHost } : {}),
    ...(sshUser ? { sshUser } : {}),
  };
}

export function resolveAllPeers(): ResolvedPeer[] {
  const peers = readPeers();
  if (!peers) return [];
  return Object.entries(peers)
    .filter(([, v]) => v && typeof v.url === "string")
    .map(([alias, v]) => {
      const sshAlias = sshAliasFrom(v);
      const sshHost = sshHostFrom(v);
      const sshUser = sshUserFrom(v);
      return {
        alias,
        url: v.url as string,
        node: typeof v.node === "string" ? v.node : null,
        ...(sshAlias ? { sshAlias } : {}),
        ...(sshHost ? { sshHost } : {}),
        ...(sshUser ? { sshUser } : {}),
      };
    });
}
