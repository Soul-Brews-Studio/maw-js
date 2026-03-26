import { loadConfig } from "./config";
import type { Session } from "./ssh";

export interface PeerStatus {
  url: string;
  reachable: boolean;
  latency?: number;
}

/**
 * Check if a peer is reachable by making a HEAD request
 */
async function checkPeerReachable(url: string): Promise<{ reachable: boolean; latency: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${url}/api/sessions`, { method: "GET", signal: AbortSignal.timeout(5000) });
    const latency = Date.now() - start;
    return { reachable: res.ok, latency };
  } catch {
    return { reachable: false, latency: Date.now() - start };
  }
}

/**
 * Get all configured peers from maw.config.json
 */
export function getPeers(): string[] {
  const config = loadConfig();
  return config.peers || [];
}

/**
 * Fetch sessions from a peer
 */
async function fetchPeerSessions(url: string): Promise<Session[]> {
  try {
    const res = await fetch(`${url}/api/sessions`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return await res.json();
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

  const result: (Session & { source?: string })[] = localSessions.map(s => ({ ...s, source: "local" }));

  // Fetch sessions from all peers in parallel
  const peerResults = await Promise.all(peers.map(async (url) => {
    const sessions = await fetchPeerSessions(url);
    return sessions.map(s => ({ ...s, source: url }));
  }));

  // Flatten and return all sessions
  return result.concat(...peerResults);
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
  const port = config.port || 3456;
  const localUrl = `http://localhost:${port}`;

  const statuses = await Promise.all(peers.map(async (url) => {
    const { reachable, latency } = await checkPeerReachable(url);
    return { url, reachable, latency };
  }));

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
    const res = await fetch(`${peerUrl}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, text }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
