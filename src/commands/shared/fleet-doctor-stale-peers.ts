/**
 * fleet-doctor-stale-peers — async network check for peer liveness.
 *
 * Separated from pure checks because it performs real HTTP I/O via curlFetch,
 * making it unsuitable for synchronous unit-test environments.
 */

import { curlFetch } from "../../sdk";
import type { PeerConfig } from "../../config";
import type { DoctorFinding } from "./fleet-doctor-checks";

export interface FleetPeerIdentity {
  node: string;
  agents: string[];
  version?: string;
}

/**
 * Check 7 — Peer URLs that don't respond to /api/identity.
 * Also gathers identities for the missing-agent check.
 */
export async function checkStalePeers(
  peers: PeerConfig[],
  timeout = 3000,
): Promise<{ findings: DoctorFinding[]; identities: Record<string, FleetPeerIdentity> }> {
  const findings: DoctorFinding[] = [];
  const identities: Record<string, FleetPeerIdentity> = {};
  await Promise.all(
    peers.map(async (p) => {
      try {
        const res = await curlFetch(`${p.url}/api/identity`, { timeout, from: "auto" /* #804 Step 4 SIGN — v3-sign cross-node /api/identity stale-check */ });
        if (!res.ok || !res.data) {
          findings.push({
            level: "warn",
            check: "stale-peer",
            fixable: false,
            message: `peer '${p.name}' (${p.url}) did not respond to /api/identity — may be offline`,
            detail: { peer: p },
          });
          return;
        }
        const { node, agents, version } = res.data as { node?: string; agents?: unknown; version?: unknown };
        if (typeof node === "string" && Array.isArray(agents)) {
          const identity: FleetPeerIdentity = {
            node,
            agents: agents.filter((a): a is string => typeof a === "string"),
          };
          if (typeof version === "string" && version.length > 0) identity.version = version;
          identities[p.name] = identity;
        }
      } catch {
        findings.push({
          level: "warn",
          check: "stale-peer",
          fixable: false,
          message: `peer '${p.name}' (${p.url}) unreachable`,
          detail: { peer: p },
        });
      }
    }),
  );
  return { findings, identities };
}
