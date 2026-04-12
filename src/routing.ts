/**
 * Shared routing resolver — unifies cmdSend (client) and /api/send (server).
 *
 * Resolution order (consensus with oracle-world:mawjs, 2026-04-09):
 *   1. Local findWindow → { type: 'local' }
 *   2. Node:prefix → namedPeers → { type: 'peer' } or { type: 'self-node' }
 *   3. Agents map → peer URL → { type: 'peer' } (skip if self-node)
 *   4. null (caller handles peer discovery fallback separately — it's async/network)
 *
 * See: Soul-Brews-Studio/maw-js#201
 */

import { findWindow, type Session } from "./find-window";
import type { MawConfig } from "./config";
import { resolveFleetSession } from "./commands/wake";

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
  sessions: Session[],
): ResolveResult {
  if (!query) return { type: "error", reason: "empty_query", detail: "no target specified", hint: "usage: maw hey <agent> <message>" };

  const selfNode = config.node ?? "local";

  // --- Step 1: Local findWindow + fleet config ---
  const localTarget = findWindow(sessions, query);
  if (localTarget) {
    return { type: "local", target: localTarget };
  }
  // Fleet config: oracle name → session name → findWindow (#281)
  const fleetSession = resolveFleetSession(query) || resolveFleetSession(query.replace(/-oracle$/, ""));
  if (fleetSession) {
    const fleetTarget = findWindow(sessions.filter(s => s.name === fleetSession), query)
      || findWindow(sessions.filter(s => s.name === fleetSession), query.replace(/-oracle$/, ""));
    if (fleetTarget) return { type: "local", target: fleetTarget };
    // Fleet config matched but session not running — try first window of fleet session
    const fleetSess = sessions.find(s => s.name === fleetSession);
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
      const selfTarget = findWindow(sessions, agentName);
      if (selfTarget) return { type: "self-node", target: selfTarget };
      // Try fleet config resolution (#281)
      const selfFleet = resolveFleetSession(agentName) || resolveFleetSession(agentName.replace(/-oracle$/, ""));
      if (selfFleet) {
        const fleetSess = sessions.find(s => s.name === selfFleet);
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

  // --- Step 3: Agents map (bare name, e.g. "homekeeper") ---
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
