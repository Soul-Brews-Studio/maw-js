/**
 * Shared routing resolver — unifies cmdSend (client) and /api/send (server).
 *
 * Resolution order (consensus with oracle-world:mawjs, 2026-04-09):
 *   1. Local findWindow → { type: 'local' }
 *   2. Node:prefix → namedPeers → { type: 'peer' } or { type: 'self-node' }
 *   3. Agents map → peer URL → { type: 'peer' } (skip if self-node)
 *   4. null (caller handles peer discovery fallback separately — it's async/network)
 *
 * Sub-PR 3 of #841 — manifest as primary lookup
 * ─────────────────────────────────────────────
 * Before falling through to the legacy agents-map step (Step 3), we now consult
 * the unified `OracleManifest` (#838 + #863) via `loadManifestCached()` (30s TTL,
 * fully synchronous). If the manifest carries a node mapping for the bare name
 * AND the passed `config` exposes a peer URL for that node, we route to the peer
 * directly — letting the manifest cover the cross-source cases the agents map
 * alone misses (fleet-only, oracles-json-only, session-only registrations).
 *
 * Critical contract — additive, not replacement:
 *   - Local resolution (Step 1) and node:prefix syntax (Step 2) ALWAYS run first.
 *     The manifest never overrides a local hit or an explicit node:agent route.
 *   - When the manifest misses, has no `node`, points at `selfNode`, or names a
 *     node with no peer URL in the passed config → we fall through to Step 3
 *     (agents map) unchanged. Existing routing tests remain green.
 *   - Manifest read failures are swallowed (try/catch) — the loader can throw
 *     on filesystem races; the hot path must not brick.
 *
 * Performance — manifest is cached at 30s, so steady-state hot-path cost is a
 * single in-memory Map lookup. Cold-start cost is ~one config read + one fleet
 * dir scan + one oracles.json read, all sync. We deliberately do NOT use the
 * async `loadManifestCachedAsync()` variant here — `resolveTarget` is on every
 * `maw hey` / `/api/send` path and must stay sync to avoid promise-chain churn.
 *
 * See: Soul-Brews-Studio/maw-js#201, #841 (sub-PR 3 of 5).
 */

import { findWindow, type Session } from "./runtime/find-window";
import type { MawConfig } from "../config";
import { resolveFleetSession } from "../commands/shared/wake";
import { loadManifestCached, type OracleManifestEntry } from "../lib/oracle-manifest";

export type { Session };

export type ResolveResult =
  | { type: "local"; target: string }
  | { type: "peer"; peerUrl: string; target: string; node: string }
  | { type: "self-node"; target: string }
  | { type: "error"; reason: string; detail: string; hint?: string }
  | null;

/**
 * Resolve a query to a local target, remote peer, or null.
 * Pure + sync — no network calls, no side effects. Testable without mocks.
 */
export function resolveTarget(
  query: string,
  config: MawConfig,
  sessions: (Session & { source?: string })[],
): ResolveResult {
  if (!query) return { type: "error", reason: "empty_query", detail: "no target specified", hint: "usage: maw hey <agent> <message>" };

  // #758: candidates that are never valid send targets must be dropped before
  // findWindow's ambiguity guard fires (#406). `-view` sessions are read-only
  // mirrors; non-"local" sources are federated records of other peers' agents
  // that this node can't deliver to via tmux send-keys.
  const writable = sessions.filter(s =>
    !s.name.endsWith("-view") &&
    (s.source === undefined || s.source === "local"),
  );

  const selfNode = config.node ?? "local";

  // --- Step 1: Local findWindow + fleet config ---
  const localTarget = findWindow(writable, query);
  if (localTarget) {
    return { type: "local", target: localTarget };
  }
  // Fleet config: oracle name → session name → findWindow (#281)
  const fleetSession = resolveFleetSession(query) || resolveFleetSession(query.replace(/-oracle$/, ""));
  if (fleetSession) {
    const fleetTarget = findWindow(writable.filter(s => s.name === fleetSession), query)
      || findWindow(writable.filter(s => s.name === fleetSession), query.replace(/-oracle$/, ""));
    if (fleetTarget) return { type: "local", target: fleetTarget };
    // Fleet config matched but session not running — try first window of fleet session
    const fleetSess = writable.find(s => s.name === fleetSession);
    if (fleetSess?.windows.length) return { type: "local", target: `${fleetSession}:${fleetSess.windows[0].index}` };
  }

  // --- Step 2: Node:prefix syntax (e.g. "mba:homekeeper") ---
  if (query.includes(":") && !query.includes("/")) {
    const colonIdx = query.indexOf(":");
    const nodeName = query.slice(0, colonIdx);
    const agentName = query.slice(colonIdx + 1);
    if (!nodeName || !agentName) return { type: "error", reason: "empty_node_or_agent", detail: `invalid format: '${query}'`, hint: "use node:agent format (e.g. mba:homekeeper)" };

    // Self-node check: "white:mawjs" from white → resolve locally
    if (nodeName === selfNode) {
      const selfTarget = findWindow(writable, agentName);
      if (selfTarget) return { type: "self-node", target: selfTarget };
      // Try fleet config resolution (#281)
      const selfFleet = resolveFleetSession(agentName) || resolveFleetSession(agentName.replace(/-oracle$/, ""));
      if (selfFleet) {
        const fleetSess = writable.find(s => s.name === selfFleet);
        if (fleetSess?.windows.length) return { type: "self-node", target: `${selfFleet}:${fleetSess.windows[0].index}` };
      }
      return { type: "error", reason: "self_not_running", detail: `'${agentName}' not found in local sessions on ${selfNode}`, hint: `maw wake ${agentName}` };
    }

    // Remote node: find peer URL
    const peerUrl = findPeerUrl(nodeName, config);
    if (peerUrl) {
      return { type: "peer", peerUrl, target: agentName, node: nodeName };
    }

    // Unknown node
    return { type: "error", reason: "unknown_node", detail: `node '${nodeName}' not in namedPeers or peers`, hint: "add to maw.config.json namedPeers" };
  }

  // --- Step 3a (NEW, Sub-PR 3 of #841): OracleManifest as primary lookup ---
  // The manifest unifies the 5 oracle registries (fleet/session/agent/oracles-json/worktree)
  // — when the agents map alone would miss (fleet-only or oracles-json-only entries),
  // the manifest still resolves the routing. We only short-circuit when the manifest
  // produces a REMOTE node AND the passed config exposes a peer URL for it: every
  // other case (no entry, self-node, no peer URL) falls through to Step 3b unchanged.
  const manifestEntry = lookupManifestEntry(query);
  if (manifestEntry?.node && manifestEntry.node !== selfNode && manifestEntry.node !== "local") {
    const peerUrl = findPeerUrl(manifestEntry.node, config);
    if (peerUrl) {
      return { type: "peer", peerUrl, target: query, node: manifestEntry.node };
    }
  }

  // --- Step 3b: Agents map (bare name, e.g. "homekeeper") ---
  const agentNode =
    config.agents?.[query] ||
    config.agents?.[query.replace(/-oracle$/, "")];

  if (agentNode) {
    // Self-node: agent is mapped to our own node → treat as local miss
    if (agentNode === selfNode) return { type: "error", reason: "self_not_running", detail: `'${query}' mapped to ${selfNode} (local) but not found in sessions`, hint: `maw wake ${query}` };

    // Remote node: find peer URL
    const peerUrl = findPeerUrl(agentNode, config);
    if (peerUrl) {
      return { type: "peer", peerUrl, target: query, node: agentNode };
    }

    // Agent mapped to unknown node (no peer URL found)
    return { type: "error", reason: "no_peer_url", detail: `'${query}' mapped to node '${agentNode}' but no URL found`, hint: `add ${agentNode} to maw.config.json namedPeers` };
  }

  // --- Step 4: Not resolved (caller handles peer discovery fallback) ---
  return { type: "error", reason: "not_found", detail: `'${query}' not in local sessions or agents map`, hint: "check: maw ls" };
}

/** Find a peer URL by node name from namedPeers or legacy peers[] */
function findPeerUrl(nodeName: string, config: MawConfig): string | undefined {
  const peer = config.namedPeers?.find((p) => p.name === nodeName);
  if (peer) return peer.url;
  return config.peers?.find((p) => p.includes(nodeName));
}

/**
 * Look up an oracle short-name in the cached `OracleManifest` (Sub-PR 3 of #841).
 *
 * Tries the raw query first, then the `-oracle`-stripped variant — mirrors the
 * normalization the agents-map step uses. Failures swallowed: a filesystem race
 * on the manifest loader must NOT brick `resolveTarget`. The 30s TTL keeps the
 * hot path on a single in-memory Map lookup in steady state.
 */
function lookupManifestEntry(query: string): OracleManifestEntry | undefined {
  if (query.includes(":") || query.includes("/")) return undefined;
  let manifest: OracleManifestEntry[];
  try {
    manifest = loadManifestCached();
  } catch {
    return undefined;
  }
  const stripped = query.replace(/-oracle$/, "");
  return (
    manifest.find((e) => e.name === query) ||
    (stripped !== query ? manifest.find((e) => e.name === stripped) : undefined)
  );
}
