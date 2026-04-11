import { join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { hostExec } from "../ssh";
import { FLEET_DIR } from "../paths";
import { loadConfig, saveConfig } from "../config";
import { loadFleet } from "./fleet-load";

interface FleetWindow {
  name: string;
  repo: string;
}

interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
}

// Default grouping: oracle name → session (1:1, no more shared sessions)
const GROUPS: Record<string, { session: string; order: number }> = {
  // Command layer (01-04) — always on
  pulse: { session: "pulse", order: 1 },
  hermes: { session: "hermes", order: 2 },
  neo: { session: "neo", order: 3 },
  homekeeper: { session: "homekeeper", order: 4 },
  // Project layer (05-10) — on demand
  volt: { session: "volt", order: 5 },
  floodboy: { session: "floodboy", order: 6 },
  fireman: { session: "fireman", order: 7 },
  dustboy: { session: "dustboy", order: 8 },
  dustboychain: { session: "dustboychain", order: 9 },
  arthur: { session: "arthur", order: 10 },
  // Knowledge layer (11-14) — on demand
  calliope: { session: "calliope", order: 11 },
  odin: { session: "odin", order: 12 },
  mother: { session: "mother", order: 13 },
  nexus: { session: "nexus", order: 14 },
  // Brewing (15)
  xiaoer: { session: "xiaoer", order: 15 },
  // Dormant (20+)
  lake: { session: "lake", order: 20 },
  sea: { session: "sea", order: 21 },
  phukhao: { session: "phukhao", order: 22 },
  shrimp: { session: "shrimp", order: 23 },
  tworivers: { session: "tworivers", order: 24 },
  brewsboy: { session: "brewsboy", order: 25 },
  natsbrain: { session: "natsbrain", order: 26 },
  opensourcenatbrain: { session: "opensourcenatbrain", order: 27 },
  maeoncraft: { session: "maeoncraft", order: 28 },
  maeon: { session: "maeoncraft", order: 28 },
  landing: { session: "landing", order: 29 },
};

export async function cmdFleetInit() {
  const fleetDir = FLEET_DIR;
  // Clean old configs to prevent duplicate numbering (#82)
  if (existsSync(fleetDir)) rmSync(fleetDir, { recursive: true });
  mkdirSync(fleetDir, { recursive: true });

  // Scan ghq for oracle repos
  console.log(`\n  \x1b[36mScanning for oracle repos...\x1b[0m\n`);

  const ghqOut = await hostExec("ghq list --full-path");
  const allRepos = ghqOut.trim().split("\n").filter(Boolean);

  // Find oracle repos
  const oracleRepos: { name: string; path: string; repo: string; worktrees: { name: string; path: string; repo: string }[] }[] = [];

  for (const repoPath of allRepos) {
    const parts = repoPath.split("/");
    const repoName = parts.pop()!;
    const org = parts.pop()!;
    const parentDir = parts.join("/") + "/" + org;

    // Match *-oracle repos or known names
    let oracleName: string | null = null;
    if (repoName.endsWith("-oracle")) {
      oracleName = repoName.replace(/-oracle$/, "").replace(/-/g, "");
    } else if (repoName === "homelab") {
      oracleName = "homekeeper";
    }

    if (!oracleName) continue;
    // Skip worktree dirs (they have .wt- in the name)
    if (repoName.includes(".wt-")) continue;

    // Find worktrees (strip number prefix from window name)
    const worktrees: { name: string; path: string; repo: string }[] = [];
    try {
      const wtOut = await hostExec(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
      const usedNames = new Set<string>();
      for (const wtPath of wtOut.split("\n").filter(Boolean)) {
        const wtBase = wtPath.split("/").pop()!;
        const suffix = wtBase.replace(`${repoName}.wt-`, "");
        const taskPart = suffix.replace(/^\d+-/, "");
        let windowName = `${oracleName}-${taskPart}`;
        if (usedNames.has(windowName)) windowName = `${oracleName}-${suffix}`; // collision fallback
        usedNames.add(windowName);
        worktrees.push({
          name: windowName,
          path: wtPath,
          repo: `${org}/${wtBase}`,
        });
      }
    } catch { /* no worktrees */ }

    oracleRepos.push({
      name: oracleName,
      path: repoPath,
      repo: `${org}/${repoName}`,
      worktrees,
    });

    const wtInfo = worktrees.length > 0 ? ` + ${worktrees.length} worktrees` : "";
    console.log(`  found: ${oracleName.padEnd(15)} ${org}/${repoName}${wtInfo}`);
  }

  // Group into sessions
  const sessionMap = new Map<string, { order: number; windows: FleetWindow[] }>();

  for (const oracle of oracleRepos) {
    const group = GROUPS[oracle.name] || { session: oracle.name, order: 50 };
    const key = group.session;

    if (!sessionMap.has(key)) {
      sessionMap.set(key, { order: group.order, windows: [] });
    }

    const sess = sessionMap.get(key)!;
    sess.windows.push({ name: `${oracle.name}-oracle`, repo: oracle.repo });

    for (const wt of oracle.worktrees) {
      sess.windows.push({ name: wt.name, repo: wt.repo });
    }
  }

  // Write fleet files
  console.log(`\n  \x1b[36mWriting fleet configs...\x1b[0m\n`);

  const sorted = [...sessionMap.entries()].sort((a, b) => a[1].order - b[1].order);

  for (const [groupName, data] of sorted) {
    const paddedNum = String(data.order).padStart(2, "0");
    const sessionName = `${paddedNum}-${groupName}`;
    const config: FleetSession = { name: sessionName, windows: data.windows };
    const filePath = join(fleetDir, `${sessionName}.json`);

    await Bun.write(filePath, JSON.stringify(config, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m ${sessionName}.json — ${data.windows.length} windows`);
  }

  // Add overview session
  if (oracleRepos.length > 0) {
    const overviewConfig: FleetSession = {
      name: "99-overview",
      windows: [{ name: "live", repo: oracleRepos[0].repo }],
      skip_command: true,
    };
    await Bun.write(join(fleetDir, "99-overview.json"), JSON.stringify(overviewConfig, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m 99-overview.json — 1 window`);
  }

  console.log(`\n  \x1b[32m${sorted.length + 1} fleet configs written to fleet/\x1b[0m`);
  console.log(`  Run \x1b[36mmaw wake all\x1b[0m to start the fleet.\n`);
}

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
