import { Elysia } from "elysia";
import { getTransportRouter } from "../transports";
import type { DiscoveredPeer } from "../transports/scout-state";

export interface DiscoveryRow {
  zid: string;
  node: string;
  oracle: string;
  host: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  firstSeen: string;
  lastSeen: string;
  seenRel: string;
  paired: boolean;
}

export interface DiscoveryResponse {
  ok: true;
  total: number;
  shown: number;
  filtered: boolean;
  peers: DiscoveryRow[];
}

export function toDiscoveryResponse(
  peers: DiscoveredPeer[],
  opts: { all?: boolean; limit?: number; now?: number } = {},
): DiscoveryResponse {
  const now = opts.now ?? Date.now();
  const filtered = opts.all ? peers : peers.filter((p) => !p.paired);
  const sorted = filtered
    .slice()
    .sort((a, b) => b.lastSeen - a.lastSeen || a.node.localeCompare(b.node));
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  const shown = sorted.slice(0, limit);
  return {
    ok: true,
    total: sorted.length,
    shown: shown.length,
    filtered: !opts.all,
    peers: shown.map((p) => ({
      zid: p.zid,
      node: p.node,
      oracle: p.oracle,
      host: p.host,
      locators: p.locators,
      capabilities: p.capabilities,
      oracles: p.oracles,
      firstSeen: new Date(p.lastSeen).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString(),
      seenRel: relativeSeen(now - p.lastSeen),
      paired: p.paired,
    })),
  };
}

export function createPeerDiscoveriesApi(
  listPeers?: () => DiscoveredPeer[],
) {
  const handler = ({ query, set }: { query: Record<string, string | undefined>; set: { status?: number } }) => {
    const all = query.all === "1" || query.all === "true";
    const limit = query.limit === undefined
      ? undefined
      : Number(query.limit);
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      set.status = 400;
      return {
        ok: false,
        error: "invalid_limit",
        hint: "limit must be a positive number",
      };
    }
    const peers = listPeers ? listPeers() : getTransportRouter().listDiscoveredPeers() as DiscoveredPeer[];
    return toDiscoveryResponse(peers, { all, limit });
  };
  return new Elysia()
    .get("/peers/discoveries", handler)
    .get("/peers/discovered", handler);
}

export const peerDiscoveriesApi = createPeerDiscoveriesApi();

function relativeSeen(deltaMs: number): string {
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
