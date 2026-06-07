import { getFederationStatus, curlFetch, listSessions } from "../../sdk";
import { loadConfig, type MawConfig } from "../../config";
import { getFederationStatusSymmetric, type PeerStatus } from "../../core/transport/peers";
import type { Session } from "../../core/runtime/find-window";
import { resolvePeerSources, type PeerSourceMode, type PeerTarget } from "./peer-sources";

type LogFn = (message?: unknown, ...optionalParams: unknown[]) => void;
type CurlFetch = typeof curlFetch;
type FederationStatus = Awaited<ReturnType<typeof getFederationStatus>>;
type PairState = "healthy" | "half-up" | "down" | "unknown";
type SymmetricPair = { url: string; pair: PairState; reason?: string };
type SymmetricStatus = {
  totalPairs: number;
  healthyPairs: number;
  localNode: string;
  pairs: SymmetricPair[];
};

export type FederationStatusDeps = {
  peerSourceMode?: PeerSourceMode;
  getPeers?: () => string[];
  loadConfig?: () => MawConfig;
  getFederationStatus?: () => Promise<FederationStatus>;
  resolvePeerSources?: typeof resolvePeerSources;
  listSessions?: () => Promise<Session[]>;
  curlFetch?: CurlFetch;
  log?: LogFn;
};

export type FederationStatusVerifyDeps = {
  loadConfig?: () => MawConfig;
  getFederationStatusSymmetric?: () => Promise<SymmetricStatus>;
  log?: LogFn;
};

async function fetchPeerAgentCount(url: string, fetch: CurlFetch = curlFetch): Promise<number> {
  try {
    const res = await fetch(`${url}/api/sessions`, { timeout: 3000 });
    if (!res.ok) return 0;
    const sessions: { windows: unknown[] }[] = res.data || [];
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** Count local agents = sum of windows across local tmux sessions. */
async function countLocalAgents(loadSessions: () => Promise<Session[]> = listSessions): Promise<number> {
  try {
    const sessions = await loadSessions();
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** Build a human-readable label for a peer URL, preferring namedPeers.name. */
function labelForPeer(url: string, named: { name: string; url: string }[], peers: PeerTarget[] = []): string {
  const resolved = peers.find(p => p.url === url && p.name);
  if (resolved?.name) return resolved.name;
  const match = named.find(p => p.url === url);
  if (match) return match.name;
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1"
      ? `localhost:${u.port}` : u.host;
  } catch { return url; }
}

/** maw federation status — show all nodes (local + peers) with connectivity + agent counts */
export async function cmdFederationStatus(deps: FederationStatusDeps = {}) {
  const config = (deps.loadConfig ?? loadConfig)();
  const resolved = deps.getPeers
    ? { peers: deps.getPeers().map((url): PeerTarget => ({ url, source: "config" })), warnings: [] as string[] }
    : await (deps.resolvePeerSources ?? resolvePeerSources)(config, deps.peerSourceMode ?? "both");
  const peerTargets = resolved.peers;
  const peers = peerTargets.map((peer) => peer.url);
  const named = config.namedPeers ?? [];
  const totalNodes = peers.length + 1; // +1 for local
  const localLabel = config.node ? `${config.node} (local)` : "local";
  const log = deps.log ?? console.log;

  // Header always includes local, so "N nodes (1 local + M peers)"
  log(
    `\n\x1b[36;1mFederation Status\x1b[0m  ` +
    `\x1b[90m${totalNodes} node${totalNodes !== 1 ? "s" : ""} ` +
    `(1 local + ${peers.length} peer${peers.length !== 1 ? "s" : ""})\x1b[0m\n`
  );
  for (const warning of resolved.warnings) {
    log(`  \x1b[33m!\x1b[0m  \x1b[90m${warning}\x1b[0m`);
  }

  // Fetch local + peer state in parallel
  const [localCount, { peers: statuses, localUrl, localReachable, localLatency }] = await Promise.all([
    countLocalAgents(deps.listSessions ?? listSessions),
    deps.getFederationStatus
      ? deps.getFederationStatus()
      : getFederationStatus({ peers: peerTargets, config }),
  ]);

  const effectiveLocalReachable = localReachable ?? true;
  const localDot = effectiveLocalReachable ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
  const localStatus = effectiveLocalReachable
    ? `\x1b[32monline\x1b[0m  \x1b[90m${localLatency ?? 0}ms · ${localCount} agent${localCount !== 1 ? "s" : ""}\x1b[0m`
    : "\x1b[31moffline\x1b[0m  \x1b[90mno listener answered self-probe; try: maw federation start\x1b[0m";

  // Render local row FIRST — the triangle is only visible if local is in the table
  log(`  ${localDot}  \x1b[37m${localLabel}\x1b[0m  ${localStatus}`);
  log(`     \x1b[90m${localUrl}\x1b[0m`);

  // No peers? Still show helpful hint.
  if (peers.length === 0) {
    log("\n\x1b[90mNo peers configured or discovered. Add namedPeers[] to maw.config.json or run maw serve with discovery enabled.\x1b[0m");
    log('\x1b[90mExample: { "namedPeers": [{ "name": "other", "url": "http://other-host:3456" }] }\x1b[0m\n');
    return;
  }

  // Fetch peer agent counts in parallel for reachable peers
  const counts = await Promise.all(
    statuses.map(p => p.reachable ? fetchPeerAgentCount(p.url, deps.curlFetch ?? curlFetch) : Promise.resolve(0))
  );

  let reachableCount = effectiveLocalReachable ? 1 : 0;
  for (let i = 0; i < statuses.length; i++) {
    const { url, reachable, latency } = statuses[i] as PeerStatus;
    const agentCount = counts[i];
    if (reachable) reachableCount++;

    const dot = reachable ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    // "reachable" is truthful — we only verified local→peer direction.
    // The reverse direction (peer→local) is NOT checked here. See PR #398
    // for the symmetric-pair proposal (`maw federation --verify`).
    const status = reachable
      ? `\x1b[32mreachable\x1b[0m  \x1b[90m${latency}ms · ${agentCount} agent${agentCount !== 1 ? "s" : ""}\x1b[0m`
      : "\x1b[31munreachable\x1b[0m";

    const label = labelForPeer(url, named, peerTargets);
    log(`  ${dot}  \x1b[37m${label}\x1b[0m  ${status}`);
    log(`     \x1b[90m${url}\x1b[0m`);
  }

  log(`\n\x1b[90m${reachableCount}/${totalNodes} reachable (one-way; use --verify for pair-symmetric check — PR #398)\x1b[0m\n`);
}

/**
 * maw federation --verify — pair-symmetric check.
 *
 * Runs the one-way `maw federation` output first, then for each reachable peer
 * asks their `/api/federation/status` whether local is in their peer list and
 * marked reachable. Classifies each pair as healthy / half-up / down / unknown
 * and exits non-zero if any pair is non-healthy.
 *
 * Exit codes (when called from CLI handler — see federation/index.ts):
 *   0 : all pairs healthy
 *   1 : at least one pair non-healthy
 */
export async function cmdFederationStatusVerify(deps: FederationStatusVerifyDeps = {}): Promise<{ ok: boolean }> {
  const getSymmetric = deps.getFederationStatusSymmetric ?? getFederationStatusSymmetric;
  const config = (deps.loadConfig ?? loadConfig)();
  const named = config.namedPeers ?? [];
  const result = await getSymmetric();
  const log = deps.log ?? console.log;

  log(
    `\n\x1b[36;1mFederation Status — Symmetric\x1b[0m  ` +
    `\x1b[90m${result.totalPairs} pair${result.totalPairs !== 1 ? "s" : ""} · local: ${result.localNode}\x1b[0m\n`
  );

  if (result.totalPairs === 0) {
    log("\x1b[90mNo peers configured. Add namedPeers[] to maw.config.json.\x1b[0m\n");
    return { ok: true };
  }

  for (const p of result.pairs) {
    const label = labelForPeer(p.url, named);
    let dot: string, state: string;
    switch (p.pair) {
      case "healthy":
        dot = "\x1b[32m●\x1b[0m";
        state = "\x1b[32mhealthy\x1b[0m  \x1b[90m(A↔B)\x1b[0m";
        break;
      case "half-up":
        dot = "\x1b[33m◐\x1b[0m";
        state = `\x1b[33mhalf-up\x1b[0m  \x1b[90m(A→B OK, B→A failed${p.reason ? `: ${p.reason}` : ""})\x1b[0m`;
        break;
      case "down":
        dot = "\x1b[31m●\x1b[0m";
        state = `\x1b[31mdown\x1b[0m  \x1b[90m(${p.reason ?? "both directions failing"})\x1b[0m`;
        break;
      case "unknown":
      default:
        dot = "\x1b[90m○\x1b[0m";
        state = `\x1b[90munknown\x1b[0m  \x1b[90m(${p.reason ?? "reverse check inconclusive"})\x1b[0m`;
        break;
    }
    log(`  ${dot}  \x1b[37m${label}\x1b[0m  ${state}`);
    log(`     \x1b[90m${p.url}\x1b[0m`);
  }

  log(`\n\x1b[90m${result.healthyPairs}/${result.totalPairs} pairs healthy\x1b[0m\n`);
  return { ok: result.healthyPairs === result.totalPairs };
}
