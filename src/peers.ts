import { loadConfig, cfgTimeout } from "./config";
import type { Session } from "./ssh";
import { curlFetch } from "./curl-fetch";

/** Simple TTL cache for aggregated sessions (#145) */
let aggregatedCache: { peers: (Session & { source?: string })[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

export interface PeerStatus {
  url: string;
  reachable: boolean;
  latency?: number;
  node?: string;
  agents?: string[];
}

/**
 * Check if a peer is reachable by making a HEAD request
 */
async function checkPeerReachable(url: string): Promise<{ reachable: boolean; latency: number; node?: string; agents?: string[] }> {
  const start = Date.now();
  try {
    const res = await curlFetch(`${url}/api/sessions`, { timeout: cfgTimeout("http") });
    const latency = Date.now() - start;
    // Fetch identity for node dedup (#192)
    let node: string | undefined;
    let agents: string[] | undefined;
    try {
      const id = await curlFetch(`${url}/api/identity`, { timeout: cfgTimeout("http") });
      if (id.ok && id.data) { node = id.data.node; agents = id.data.agents; }
    } catch {}
    return { reachable: res.ok, latency, node, agents };
  } catch {
    return { reachable: false, latency: Date.now() - start };
  }
}

/**
 * Get all configured peers from maw.config.json — merges flat peers[]
 * with namedPeers[].url, deduped by URL (first occurrence wins).
 * Both sources feed the same federation peer list.
 */
export function getPeers(): string[] {
  const config = loadConfig();
  const flat = config.peers ?? [];
  const named = (config.namedPeers ?? []).map(p => p.url);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [...flat, ...named]) {
    if (!seen.has(url)) {
      seen.add(url);
      merged.push(url);
    }
  }
  return merged;
}

/**
 * Fetch sessions from a peer
 */
async function fetchPeerSessions(url: string): Promise<Session[]> {
  try {
    const res = await curlFetch(`${url}/api/sessions?local=true`, { timeout: cfgTimeout("http") });
    if (!res.ok) return [];
    return res.data || [];
  } catch {
    return [];
  }
}

/**
 * Merge local sessions with peer sessions, tagging each with source
 */
export async function getAggregatedSessions(localSessions: Session[]): Promise<(Session & { source?: string })[]> {
  const peers = getPeers();
  if (peers.length === 0) {
    return localSessions;
  }

  const local: (Session & { source?: string })[] = localSessions.map(s => ({ ...s, source: "local" }));

  // Return cached peer sessions if fresh (#145)
  if (aggregatedCache && Date.now() - aggregatedCache.ts < CACHE_TTL) {
    return [...local, ...aggregatedCache.peers];
  }

  // Fetch sessions from all peers in parallel
  const peerResults = await Promise.all(peers.map(async (url) => {
    const sessions = await fetchPeerSessions(url);
    return sessions.map(s => ({ ...s, source: url }));
  }));

  // Dedup sessions by source + name (#175)
  const seen = new Set<string>();
  const peerSessions = peerResults.flat().filter(s => {
    const key = `${s.source}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  aggregatedCache = { peers: peerSessions, ts: Date.now() };

  return [...local, ...peerSessions];
}

/**
 * Get federation status — list peers and check connectivity
 */
export async function getFederationStatus(): Promise<{
  localUrl: string;
  peers: PeerStatus[];
  totalPeers: number;
  reachablePeers: number;
}> {
  const config = loadConfig();
  const peers = getPeers();
  const port = loadConfig().port;
  const localUrl = `http://localhost:${port}`;

  const rawStatuses = await Promise.all(peers.map(async (url) => {
    const { reachable, latency, node, agents } = await checkPeerReachable(url);
    return { url, reachable, latency, node, agents };
  }));

  // Dedup by node identity (#190) — keep fastest URL per node
  const byNode = new Map<string, PeerStatus>();
  for (const s of rawStatuses) {
    const key = s.node || s.url; // fall back to URL if no identity
    const existing = byNode.get(key);
    if (!existing || (s.reachable && (!existing.reachable || (s.latency ?? Infinity) < (existing.latency ?? Infinity)))) {
      byNode.set(key, s);
    }
  }
  const statuses = [...byNode.values()];
  const reachablePeers = statuses.filter(s => s.reachable).length;

  return {
    localUrl,
    peers: statuses,
    totalPeers: peers.length,
    reachablePeers,
  };
}

/**
 * Find which peer a target session comes from, or return null if local
 */
export async function findPeerForTarget(target: string, localSessions: Session[]): Promise<string | null> {
  const aggregated = await getAggregatedSessions(localSessions);
  const session = aggregated.find(s => s.name === target || s.windows.some(w => `${s.name}:${w.name}` === target));
  return session?.source === "local" ? null : (session?.source || null);
}

/**
 * Send keys to a target on a peer
 */
export async function sendKeysToPeer(peerUrl: string, target: string, text: string): Promise<boolean> {
  try {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target, text }),
      timeout: cfgTimeout("http"),
    });
    return res.ok;
  } catch {
    return false;
  }
}
