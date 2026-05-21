/**
 * fleet-doctor-checks — pure, side-effect-free check functions.
 *
 * Each function takes only in-memory data and returns DoctorFinding[].
 * No network, no filesystem I/O — safe to unit-test without stubs.
 *
 * checkMissingRepos (uses existsSync) lives in fleet-doctor-checks-repo.ts.
 */

import type { PeerConfig } from "../../config";

export type Level = "error" | "warn" | "info";

export interface DoctorFinding {
  level: Level;
  check: string;
  message: string;
  fixable: boolean;
  detail?: Record<string, unknown>;
}

interface PeerVersionIdentity {
  node: string;
  version?: string;
}

/**
 * Check 1 — Substring collisions between namedPeer names and local session names.
 *
 * Root cause of #239: `maw hey white:mawjs-oracle` misrouted to `105-whitekeeper`
 * because findWindow's fallback substring-matched "white" against the longer
 * session name. The fix was code-level (strict matchSession), but a future
 * oracle whose name contains a peer name could re-expose the same class.
 *
 * Flags the class, not the specific regression.
 */
export function checkCollisions(sessionNames: string[], peerNames: string[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const peer of peerNames) {
    const p = peer.toLowerCase();
    if (!p) continue;
    for (const sess of sessionNames) {
      const s = sess.toLowerCase();
      if (s === p) continue;                        // exact match — fine
      if (s.replace(/^\d+-/, "") === p) continue;   // "NN-<peer>" form — fine
      if (s.includes(p)) {
        findings.push({
          level: "error",
          check: "collision",
          fixable: false,
          message: `peer '${peer}' is a substring of local session '${sess}' — federation routing can misfire (class of #239)`,
          detail: { peer, session: sess },
        });
      }
    }
  }
  return findings;
}

/**
 * Check 2 — Oracles reachable on a peer but missing from config.agents map.
 *
 * mawui caught this tonight: `maw hey volt-colab-ml` failed because nothing
 * told the local node which machine hosted it. Users had to fall back to
 * `white:volt-colab-ml`. Once added to config.agents, bare names route cleanly.
 *
 * peerAgents keys are peer *node* names (not peer config names) so the fix
 * writes the correct routing value.
 */
export function checkMissingAgents(
  localAgents: Record<string, string>,
  peerAgents: Record<string, string[]>,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const [peerNode, oracles] of Object.entries(peerAgents)) {
    for (const oracle of oracles) {
      if (localAgents[oracle]) continue;
      findings.push({
        level: "warn",
        check: "missing-agent",
        fixable: true,
        message: `oracle '${oracle}' lives on peer '${peerNode}' but is absent from config.agents — bare \`maw hey ${oracle}\` will not route`,
        detail: { oracle, peerNode },
      });
    }
  }
  return findings;
}

/**
 * Check 3 — config.agents entries pointing to an unknown node.
 *
 * e.g. `"homekeeper": "mba"` but `mba` is neither the local node nor any
 * namedPeer. The route is dead on arrival.
 */
export function checkOrphanRoutes(
  agents: Record<string, string>,
  peerNames: string[],
  localNode: string,
): DoctorFinding[] {
  const known = new Set<string>([localNode, "local", ...peerNames]);
  const findings: DoctorFinding[] = [];
  for (const [oracle, node] of Object.entries(agents)) {
    if (!known.has(node)) {
      findings.push({
        level: "error",
        check: "orphan-route",
        fixable: false,
        message: `config.agents['${oracle}'] = '${node}', but '${node}' is not a known node (not local, not in namedPeers)`,
        detail: { oracle, node },
      });
    }
  }
  return findings;
}

/**
 * Check 4 — Duplicate namedPeers (same name → ambiguous routing, same URL → wasted fanout).
 */
export function checkDuplicatePeers(peers: PeerConfig[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const byName = new Map<string, number>();
  const byUrl = new Map<string, number>();
  for (const p of peers) {
    byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
    byUrl.set(p.url, (byUrl.get(p.url) ?? 0) + 1);
  }
  for (const [name, count] of byName) {
    if (count > 1) {
      findings.push({
        level: "warn",
        check: "duplicate-peer",
        fixable: true,
        message: `namedPeer '${name}' appears ${count} times — routing is ambiguous`,
        detail: { kind: "name", value: name, count },
      });
    }
  }
  for (const [url, count] of byUrl) {
    if (count > 1) {
      findings.push({
        level: "warn",
        check: "duplicate-peer",
        fixable: true,
        message: `namedPeer URL '${url}' appears ${count} times — federation will fan out redundantly`,
        detail: { kind: "url", value: url, count },
      });
    }
  }
  return findings;
}

/**
 * Check 5 — Peer pointing back at this node. Would loop federation traffic.
 */
export function checkSelfPeer(
  peers: PeerConfig[],
  localNode: string,
  localPort: number,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const p of peers) {
    const loopByName = !!localNode && p.name === localNode;
    let loopByUrl = false;
    try {
      const u = new URL(p.url);
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      if (
        port === localPort &&
        (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0")
      ) {
        loopByUrl = true;
      }
    } catch { /* invalid URL — a namedPeer validator upstream should have caught it */ }
    if (loopByName || loopByUrl) {
      findings.push({
        level: "warn",
        check: "self-peer",
        fixable: true,
        message: `namedPeer '${p.name}' points at this node — would create a federation loop`,
        detail: { peer: p, reason: loopByName ? "name" : "url" },
      });
    }
  }
  return findings;
}

/**
 * Check 8 — Peer maw version skew.
 *
 * #1815 showed the failure mode: local alpha already had repo-local Discord
 * `--channels` auto-detect, but a remote anchor still running an older maw
 * silently launched Discord bots without that feature. `/api/identity` already
 * advertises each peer's maw package version; surface mismatches as warn-level
 * operator drift instead of letting feature skew stay invisible.
 */
export function checkPeerVersionSkew(
  localVersion: string | undefined,
  identities: Record<string, PeerVersionIdentity>,
): DoctorFinding[] {
  if (!localVersion) return [];
  const findings: DoctorFinding[] = [];
  for (const [peer, identity] of Object.entries(identities)) {
    if (!identity.version || identity.version === localVersion) continue;
    findings.push({
      level: "warn",
      check: "version-skew",
      fixable: false,
      message: `peer '${peer}' (${identity.node}) runs maw ${identity.version}, local is ${localVersion} — version skew can silently drop fleet features such as wake Discord --channels auto-detect`,
      detail: {
        peer,
        node: identity.node,
        peerVersion: identity.version,
        localVersion,
      },
    });
  }
  return findings;
}
