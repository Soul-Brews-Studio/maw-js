import { loadConfig, cfgTimeout } from "../../config";
import type { Session } from "./ssh";
import { curlFetch } from "./curl-fetch";

/**
 * Schema validation at the federation boundary.
 *
 * Peer-supplied session names must match the tmux-safe character set
 * [a-zA-Z0-9_.-] before we allow them into resolveTarget() and other
 * code paths that may construct tmux targets from session names.
 * Items failing validation are dropped and warned, never propagated.
 */
function isValidPeerSession(item: unknown): item is Session {
  if (!item || typeof item !== "object") return false;
  const s = item as Record<string, unknown>;
  return (
    typeof s.name === "string" &&
    /^[a-zA-Z0-9_.\-]+$/.test(s.name) &&
    Array.isArray(s.windows)
  );
}

/** Simple TTL cache for aggregated sessions (#145) */
let aggregatedCache: { peers: (Session & { source?: string })[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

export interface PeerStatus {
  url: string;
  reachable: boolean;
  latency?: number;
  node?: string;
  agents?: string[];
  clockDeltaMs?: number;
  clockWarning?: boolean;
}

/** Clock drift warning threshold — 3 minutes (early warning before 5-min HMAC cutoff) (#268) */
const CLOCK_WARN_MS = 3 * 60 * 1000;

/**
 * Check if a peer is reachable by making a GET /api/sessions request.
 *
 * ONE-WAY ONLY. This verifies local→peer reach. It does NOT verify that
 * the peer can reach back (peer→local). Asymmetric-NAT, one-sided firewall
 * rules, and one-sided WireGuard configs all produce the state where
 * `reachable: true` but the peer cannot message us.
 *
 * For symmetric pair verification, see `getFederationStatusSymmetric()`
 * (PR #398) and the `maw federation --verify` CLI flag.
 */
async function checkPeerReachable(url: string): Promise<{
  reachable: boolean; latency: number; node?: string; agents?: string[]; clockDeltaMs?: number;
}> {
  const start = Date.now();
  try {
    const res = await curlFetch(`${url}/api/sessions`, { timeout: cfgTimeout("http") });
    const latency = Date.now() - start;
    // Fetch identity for node dedup (#192) + clock delta (#268)
    let node: string | undefined;
    let agents: string[] | undefined;
    let clockDeltaMs: number | undefined;
    try {
      const beforeId = Date.now();
      const id = await curlFetch(`${url}/api/identity`, { timeout: cfgTimeout("http"), from: "auto" /* #804 Step 4 SIGN — v3-sign cross-node /api/identity probe */ });
      const afterId = Date.now();
      if (id.ok && id.data) {
        node = id.data.node;
        agents = id.data.agents;
        // Compute clock delta if peer exposes clockUtc (#268)
        if (id.data.clockUtc) {
          const peerTime = new Date(id.data.clockUtc).getTime();
          const localTime = (beforeId + afterId) / 2; // midpoint compensates for network latency
          clockDeltaMs = peerTime - localTime;
        }
      } else if (res.ok) {
        // Peer is reachable (sessions ok) but identity fetch failed — node/agents
        // will be undefined. Surface so "reachable=true node=undefined" confusion
        // is diagnosable (#385 site 3). Scoped to res.ok so fully-down peers
        // don't double-warn (sessions failure already implies identity failure).
        console.warn(
          `[peers] checkPeerReachable ${url}/api/identity: status=${id.status}`,
        );
      }
    } catch (err) {
      if (res.ok) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[peers] checkPeerReachable ${url}/api/identity: ${msg}`);
      }
    }
    return { reachable: res.ok, latency, node, agents, clockDeltaMs };
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
    const raw = res.data;
    if (!Array.isArray(raw)) return [];
    // Validate at federation boundary — drop sessions with malformed names
    const valid: Session[] = [];
    for (const item of raw) {
      if (isValidPeerSession(item)) {
        valid.push(item);
      } else {
        console.warn(
          `[peers] dropped malformed session from ${url}:`,
          JSON.stringify(item).slice(0, 120),
        );
      }
    }
    return valid;
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
 * Get federation status — list peers and check connectivity + clock health (#268)
 */
export async function getFederationStatus(): Promise<{
  localUrl: string;
  peers: PeerStatus[];
  totalPeers: number;
  reachablePeers: number;
  clockHealth: {
    clockUtc: string;
    timezone: string;
    uptimeSeconds: number;
  };
}> {
  const config = loadConfig();
  const peers = getPeers();
  const port = loadConfig().port;
  const localUrl = `http://localhost:${port}`;

  const rawStatuses = await Promise.all(peers.map(async (url) => {
    const { reachable, latency, node, agents, clockDeltaMs } = await checkPeerReachable(url);
    return { url, reachable, latency, node, agents, clockDeltaMs };
  }));

  // Dedup by node identity (#190) — keep fastest URL per node
  const byNode = new Map<string, PeerStatus>();
  for (const s of rawStatuses) {
    const key = s.node || s.url; // fall back to URL if no identity
    const existing = byNode.get(key);
    if (!existing || (s.reachable && (!existing.reachable || (s.latency ?? Infinity) < (existing.latency ?? Infinity)))) {
      const clockWarning = s.clockDeltaMs != null ? Math.abs(s.clockDeltaMs) > CLOCK_WARN_MS : undefined;
      byNode.set(key, { ...s, clockWarning });
    }
  }
  const statuses = [...byNode.values()];
  const reachablePeers = statuses.filter(s => s.reachable).length;

  return {
    localUrl,
    peers: statuses,
    totalPeers: peers.length,
    reachablePeers,
    clockHealth: {
      clockUtc: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uptimeSeconds: Math.floor(process.uptime()),
    },
  };
}

/**
 * Pair-health verification — cross-check that the peer's view includes us.
 *
 * `getFederationStatus()` only measures local→peer reach. This function
 * classifies the pair state by also asking the peer "do you see me?":
 *
 *   - healthy : forward reach OK AND local appears in peer's peer list marked reachable
 *   - half-up : forward reach OK but reverse is not (we're missing from peer's view,
 *               or they have us but mark us unreachable)
 *   - down    : forward reach itself fails
 *   - unknown : forward OK but we couldn't fetch peer's /api/federation/status
 *
 * See ψ/lab/federation-audit/pair-health-failure.md (mawjs-no2-oracle) for
 * the full invariant + failure-scenario catalogue.
 */
export interface PairStatus {
  url: string;
  node?: string;
  pair: "healthy" | "half-up" | "down" | "unknown";
  forward: boolean;
  reverse: boolean | null;
  reason?: string;
  latency?: number;
  agents?: string[];
  clockWarning?: boolean;
}

/**
 * Optional dependency injections for `getFederationStatusSymmetric`.
 * Passing nothing uses production behavior; tests inject to avoid the
 * mock.module process-global-pollution finding from Bloom's federation-audit
 * iteration 4 (3 PR #398 description explains).
 */
export interface SymmetricDeps {
  /** Pre-computed baseline. If omitted, `getFederationStatus()` is called. */
  baseStatus?: Awaited<ReturnType<typeof getFederationStatus>>;
  /** Fetcher used for peer /api/federation/status cross-queries. Defaults to curlFetch. */
  fetch?: typeof curlFetch;
  /** Local node identity. Defaults to loadConfig().node ?? "local". */
  localNode?: string;
}

export async function getFederationStatusSymmetric(deps: SymmetricDeps = {}): Promise<{
  localUrl: string;
  localNode: string;
  pairs: PairStatus[];
  healthyPairs: number;
  totalPairs: number;
}> {
  const localNode = deps.localNode ?? loadConfig().node ?? "local";
  const fetchImpl = deps.fetch ?? curlFetch;
  const base = deps.baseStatus ?? await getFederationStatus();

  const pairs = await Promise.all(base.peers.map(async (peer): Promise<PairStatus> => {
    const shared = {
      url: peer.url,
      node: peer.node,
      latency: peer.latency,
      agents: peer.agents,
      clockWarning: peer.clockWarning,
    };

    if (!peer.reachable) {
      return { ...shared, pair: "down", forward: false, reverse: null, reason: "forward unreachable" };
    }

    // Forward works; ask the peer for its view and look for ourselves in it.
    try {
      const res = await fetchImpl(`${peer.url}/api/federation/status`, { timeout: cfgTimeout("http") });
      if (!res.ok || !res.data) {
        return {
          ...shared,
          pair: "unknown",
          forward: true,
          reverse: null,
          reason: `peer /api/federation/status returned ${res.status}`,
        };
      }
      const peerView = res.data as { peers?: Array<{ url?: string; node?: string; reachable?: boolean }> };
      const peerPeers = peerView.peers ?? [];
      const meInPeerView = peerPeers.find(p => {
        if (p.node && localNode && p.node === localNode) return true;
        if (p.url && p.url === base.localUrl) return true;
        return false;
      });
      if (!meInPeerView) {
        return {
          ...shared,
          pair: "half-up",
          forward: true,
          reverse: false,
          reason: "local node not in peer's peer list",
        };
      }
      if (meInPeerView.reachable === false) {
        return {
          ...shared,
          pair: "half-up",
          forward: true,
          reverse: false,
          reason: "peer's view of local is unreachable",
        };
      }
      return { ...shared, pair: "healthy", forward: true, reverse: true };
    } catch (err) {
      return {
        ...shared,
        pair: "unknown",
        forward: true,
        reverse: null,
        reason: `peer status fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }));

  const healthyPairs = pairs.filter(p => p.pair === "healthy").length;
  return {
    localUrl: base.localUrl,
    localNode,
    pairs,
    healthyPairs,
    totalPairs: pairs.length,
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
 * Send keys to a target on a peer.
 *
 * Returns false on any failure. Previously both the non-ok response path
 * and the thrown-exception path were silently swallowed — TransportManager
 * would log "send failed, trying next" with no trace of the underlying
 * status/body (401 HMAC, timeout, etc.). Now we surface a structured warn
 * before returning false so federation diagnostics can find it (#385 site 2).
 */
export async function sendKeysToPeer(peerUrl: string, target: string, text: string): Promise<boolean> {
  try {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target, text }),
      timeout: cfgTimeout("http"),
      from: "auto", // #804 Step 4 SIGN — sign cross-node /api/send via TransportManager
    });
    if (!res.ok) {
      const bodySnippet = res.data != null
        ? (typeof res.data === "string" ? res.data : JSON.stringify(res.data)).slice(0, 200)
        : "";
      console.warn(
        `[peers] sendKeysToPeer ${peerUrl} → ${target}: status=${res.status}${bodySnippet ? ` body=${bodySnippet}` : ""}`,
      );
    }
    return res.ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[peers] sendKeysToPeer ${peerUrl} → ${target}: ${msg}`);
    return false;
  }
}
