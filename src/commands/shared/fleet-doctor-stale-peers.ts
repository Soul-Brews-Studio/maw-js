/**
 * fleet-doctor-stale-peers — async network check for peer liveness.
 *
 * Separated from pure checks because it performs real HTTP I/O via curlFetch,
 * making it unsuitable for synchronous unit-test environments.
 */

import { curlFetch } from "../../sdk";
import type { PeerConfig } from "../../config";
import type { DoctorFinding } from "./fleet-doctor-checks";

/**
 * Check 7 — Peer URLs that don't respond to /api/identity.
 * Also gathers identities for the missing-agent check.
 */
export async function checkStalePeers(
  peers: PeerConfig[],
  timeout = 3000,
): Promise<{ findings: DoctorFinding[]; identities: Record<string, { node: string; agents: string[] }> }> {
  const findings: DoctorFinding[] = [];
  const identities: Record<string, { node: string; agents: string[] }> = {};
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
        const { node, agents } = res.data as { node?: string; agents?: unknown };
        if (typeof node === "string" && Array.isArray(agents)) {
          identities[p.name] = { node, agents: agents.filter((a): a is string => typeof a === "string") };
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
