import { loadConfig, saveConfig } from "../../../config";
import { loadFleet } from "../../shared/fleet-load";

export interface FleetInitAgentsResult {
  added: Record<string, string>;
  existingPreserved: number;
  peersReached: number;
  peersFailed: string[];
  total: number;
}

/**
 * Reconcile `config.agents` against local fleet windows + federation peers.
 *
 * Mechanical, additive-only:
 *   - Local fleet windows → agents[name] = "local" (unless already set)
 *   - For each namedPeer, fetch {url}/api/config and adopt any entry
 *     the peer marks as "local" → agents[name] = peer.name (unless already set)
 *   - Never overwrites user-set values, never deletes
 *
 * Fixes the drift reported in #215 (boonkeeper on oracle-world had a stale
 * agents map that cost vpnkeeper 30+ minutes diagnosing a `maw hey volt`
 * failure). Additive-only preserves any hand-tuned overrides.
 */
export async function cmdFleetInitAgents(
  opts: { dryRun?: boolean } = {},
): Promise<FleetInitAgentsResult> {
  const current = loadConfig();
  const existing: Record<string, string> = { ...(current.agents || {}) };
  const proposed: Record<string, string> = { ...existing };
  const peersFailed: string[] = [];
  let peersReached = 0;

  console.log(`\n  \x1b[36mReconciling config.agents...\x1b[0m\n`);

  // 1. Local fleet windows → "local"
  let localScanned = 0;
  try {
    const fleet = loadFleet();
    for (const sess of fleet) {
      for (const w of sess.windows || []) {
        if (!w?.name) continue;
        localScanned++;
        if (!(w.name in proposed)) proposed[w.name] = "local";
      }
    }
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e.message}`);
  }

  // 2. namedPeers → fetch {url}/api/config and adopt their "local" agents
  for (const peer of current.namedPeers || []) {
    if (!peer?.url || !peer?.name) continue;
    try {
      const res = await fetch(`${peer.url}/api/config`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        peersFailed.push(`${peer.name} (HTTP ${res.status})`);
        continue;
      }
      const pcfg = (await res.json()) as { agents?: Record<string, string> };
      const peerAgents = pcfg.agents || {};
      peersReached++;
      for (const [name, host] of Object.entries(peerAgents)) {
        // Only adopt entries the peer owns (host === "local") — skip their
        // view of other peers, which may be stale on their side too.
        if (host === "local" && !(name in proposed)) {
          proposed[name] = peer.name;
        }
      }
    } catch (e: any) {
      peersFailed.push(`${peer.name} (${e?.message || "unknown"})`);
    }
  }

  // 3. Diff report
  const added: Record<string, string> = {};
  for (const [k, v] of Object.entries(proposed)) {
    if (existing[k] !== v) added[k] = v;
  }

  const result: FleetInitAgentsResult = {
    added,
    existingPreserved: Object.keys(existing).length,
    peersReached,
    peersFailed,
    total: Object.keys(proposed).length,
  };

  // Render
  console.log(
    `  scanned: \x1b[36m${localScanned}\x1b[0m local window(s), \x1b[36m${peersReached}\x1b[0m peer(s) reached`,
  );
  if (peersFailed.length > 0) {
    console.log(`  \x1b[33m⚠\x1b[0m peers unreachable: ${peersFailed.join(", ")}`);
  }
  console.log(`  preserved: \x1b[36m${Object.keys(existing).length}\x1b[0m existing entries`);

  const addedKeys = Object.keys(added);
  if (addedKeys.length === 0) {
    console.log(`\n  \x1b[32m○\x1b[0m agents map already in sync (${Object.keys(proposed).length} entries)\n`);
    return result;
  }

  console.log(`\n  new entries (${addedKeys.length}):`);
  const pad = Math.max(...addedKeys.map(k => k.length));
  for (const k of addedKeys.sort()) {
    const host = added[k] === "local" ? "\x1b[32mlocal\x1b[0m" : `\x1b[36m${added[k]}\x1b[0m`;
    console.log(`    \x1b[32m+\x1b[0m ${k.padEnd(pad)}  →  ${host}`);
  }

  if (opts.dryRun) {
    console.log(`\n  \x1b[33mdry-run:\x1b[0m no changes written (run without --dry-run to apply)\n`);
    return result;
  }

  saveConfig({ agents: proposed });
  console.log(`\n  \x1b[32m✓\x1b[0m wrote ${addedKeys.length} new entries to config.agents (${Object.keys(proposed).length} total)\n`);
  return result;
}
