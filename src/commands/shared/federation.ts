import { getFederationStatus, getPeers, curlFetch, listSessions } from "../../sdk";
import { loadConfig } from "../../config";
import { loadPeers, type Peer } from "../../lib/peers/store";

async function fetchPeerAgentCount(url: string): Promise<number> {
  try {
    const res = await curlFetch(`${url}/api/sessions`, { timeout: 3000 });
    if (!res.ok) return 0;
    const sessions: { windows: unknown[] }[] = res.data || [];
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** Count local agents = sum of windows across local tmux sessions. */
async function countLocalAgents(): Promise<number> {
  try {
    const sessions = await listSessions();
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** Build a human-readable label for a peer URL, preferring namedPeers.name. */
function labelForPeer(url: string, named: { name: string; url: string }[]): string {
  const match = named.find(p => p.url === url);
  if (match) return match.name;
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1"
      ? `localhost:${u.port}` : u.host;
  } catch { return url; }
}

/**
 * Options for `cmdFederationStatus` (#1329).
 *
 * Defaults preserve byte-for-byte parity with pre-#1329 output — see
 * verification matrix in PR. Both flags are additive: `-av` produces a
 * row block with both the `node:` line (from `-a`) and the
 * `pubkey/lastSeen/version/oracle` line (from `-v`).
 */
export interface FederationStatusOpts {
  /** -a / --all: also surface node identity per row. */
  all?: boolean;
  /** -v / --verbose: also surface pubkey/lastSeen/version/oracle per row (cached read only — no HTTP). */
  verbose?: boolean;
}

/**
 * Find the cached peer entry (~/.maw/peers.json) that matches a federation
 * peer by URL or node identity. URL match wins; node match is the fallback
 * for peers whose runtime URL differs from the cached entry (e.g. WireGuard
 * vs LAN alias for the same node).
 */
function findCachedPeer(
  url: string,
  nodeName: string | undefined,
  store: Record<string, Peer>,
): Peer | undefined {
  for (const p of Object.values(store)) {
    if (p.url === url) return p;
  }
  if (nodeName) {
    for (const p of Object.values(store)) {
      if (p.node === nodeName) return p;
    }
  }
  return undefined;
}

/** Format an ISO timestamp for verbose rows — trim sub-second precision; `never` if null. */
function fmtLastSeen(iso: string | null | undefined): string {
  if (!iso) return "never";
  // 2026-05-12T06:44:52.801Z → 2026-05-12T06:44:52Z
  return iso.replace(/\.\d+Z$/, "Z");
}

/** maw federation status — show all nodes (local + peers) with connectivity + agent counts */
export async function cmdFederationStatus(opts: FederationStatusOpts = {}) {
  const { all = false, verbose = false } = opts;
  const peers = getPeers();
  const config = loadConfig();
  const named = config.namedPeers ?? [];
  const totalNodes = peers.length + 1; // +1 for local
  const localLabel = config.node ? `${config.node} (local)` : "local";

  // -v reads the on-disk TOFU cache (~/.maw/peers.json). Loaded once up-front
  // so the per-row lookups are O(1) Map probes — no fs hit per peer.
  // We deliberately do NOT make HTTP calls per peer for version etc; uncached
  // fields render as "unknown" / "-" (#1329 design: cached-only default flow).
  const peerStore = verbose ? loadPeers().peers : {};

  // Header always includes local, so "N nodes (1 local + M peers)"
  console.log(
    `\n\x1b[36;1mFederation Status\x1b[0m  ` +
    `\x1b[90m${totalNodes} node${totalNodes !== 1 ? "s" : ""} ` +
    `(1 local + ${peers.length} peer${peers.length !== 1 ? "s" : ""})\x1b[0m\n`
  );

  // Fetch local + peer state in parallel
  const [localCount, { peers: statuses, localUrl }] = await Promise.all([
    countLocalAgents(),
    getFederationStatus(),
  ]);

  // Render local row FIRST — the triangle is only visible if local is in the table
  console.log(
    `  \x1b[32m●\x1b[0m  \x1b[37m${localLabel}\x1b[0m  ` +
    `\x1b[32monline\x1b[0m  ` +
    `\x1b[90m${localCount} agent${localCount !== 1 ? "s" : ""}\x1b[0m`
  );
  console.log(`     \x1b[90m${localUrl}\x1b[0m`);

  // No peers? Still show helpful hint.
  if (peers.length === 0) {
    console.log("\n\x1b[90mNo peers configured. Add namedPeers[] to maw.config.json.\x1b[0m");
    console.log('\x1b[90mExample: { "namedPeers": [{ "name": "other", "url": "http://other-host:3456" }] }\x1b[0m\n');
    return;
  }

  // Fetch peer agent counts in parallel for reachable peers
  const counts = await Promise.all(
    statuses.map(p => p.reachable ? fetchPeerAgentCount(p.url) : Promise.resolve(0))
  );

  let reachableCount = 1; // local is always reachable (we're executing in it)
  for (let i = 0; i < statuses.length; i++) {
    const { url, reachable, latency } = statuses[i];
    const agentCount = counts[i];
    if (reachable) reachableCount++;

    const dot = reachable ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    // "reachable" is truthful — we only verified local→peer direction.
    // The reverse direction (peer→local) is NOT checked here. See PR #398
    // for the symmetric-pair proposal (`maw federation --verify`).
    const status = reachable
      ? `\x1b[32mreachable\x1b[0m  \x1b[90m${latency}ms · ${agentCount} agent${agentCount !== 1 ? "s" : ""}\x1b[0m`
      : "\x1b[31munreachable\x1b[0m";

    const label = labelForPeer(url, named);
    console.log(`  ${dot}  \x1b[37m${label}\x1b[0m  ${status}`);
    console.log(`     \x1b[90m${url}\x1b[0m`);

    // -a: surface the node identity (best-effort from /api/identity probe).
    // Falls back to "(unknown)" when the peer is unreachable AND has never
    // exposed an identity — otherwise the live probe wins over cached.
    if (all) {
      const nodeName = statuses[i].node
        ?? findCachedPeer(url, undefined, peerStore)?.node
        ?? "(unknown)";
      console.log(`     \x1b[90mnode: ${nodeName}\x1b[0m`);
    }

    // -v: surface cached TOFU fields. No HTTP calls — uncached = literal "unknown" / "-".
    // Version has no cached field in peers.json today (#1329 open-question 1 deferred
    // to a follow-up that wires a `version` write during probePeer); always "unknown".
    if (verbose) {
      const cached = findCachedPeer(url, statuses[i].node, peerStore);
      const pubkey = cached?.pubkey ? cached.pubkey.slice(0, 8) : "-";
      const lastSeen = fmtLastSeen(cached?.lastSeen);
      const version = "unknown";
      const oracle = cached?.identity?.oracle ?? "-";
      console.log(
        `     \x1b[90mpubkey: ${pubkey}  lastSeen: ${lastSeen}  version: ${version}  oracle: ${oracle}\x1b[0m`,
      );
    }
  }

  console.log(`\n\x1b[90m${reachableCount}/${totalNodes} reachable (one-way; use --verify for pair-symmetric check — PR #398)\x1b[0m\n`);
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
export async function cmdFederationStatusVerify(): Promise<{ ok: boolean }> {
  const { getFederationStatusSymmetric } = await import("../../core/transport/peers");
  const config = loadConfig();
  const named = config.namedPeers ?? [];
  const result = await getFederationStatusSymmetric();

  console.log(
    `\n\x1b[36;1mFederation Status — Symmetric\x1b[0m  ` +
    `\x1b[90m${result.totalPairs} pair${result.totalPairs !== 1 ? "s" : ""} · local: ${result.localNode}\x1b[0m\n`
  );

  if (result.totalPairs === 0) {
    console.log("\x1b[90mNo peers configured. Add namedPeers[] to maw.config.json.\x1b[0m\n");
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
    console.log(`  ${dot}  \x1b[37m${label}\x1b[0m  ${state}`);
    console.log(`     \x1b[90m${p.url}\x1b[0m`);
  }

  console.log(`\n\x1b[90m${result.healthyPairs}/${result.totalPairs} pairs healthy\x1b[0m\n`);
  return { ok: result.healthyPairs === result.totalPairs };
}
