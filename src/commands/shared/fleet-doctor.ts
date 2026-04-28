/**
 * maw fleet doctor — federation config health check.
 *
 * Encodes the lessons of a rough night (2026-04-10) as preventive checks so
 * fleet growth can't silently re-introduce the same failure modes:
 *
 *   - #239  substring collision between peer name and session name
 *           ("white" hid inside "105-whitekeeper" and misrouted federation)
 *   - mawui's catch: oracle visible on a peer but unreachable via bare name
 *           because config.agents didn't know which node hosted it
 *   - #237  wake cold-start — fleet referenced a repo not in ghq
 *
 * The pure check functions are deliberately side-effect-free so they can be
 * unit-tested without touching the network or the tmux socket.
 *
 * Sub-modules:
 *   fleet-doctor-checks.ts      — pure checks + DoctorFinding/Level types
 *   fleet-doctor-stale-peers.ts — async network check (checkStalePeers)
 *   fleet-doctor-fixer.ts       — autoFix + color/icon helpers
 */

export type { Level, DoctorFinding } from "./fleet-doctor-checks";
export {
  checkCollisions,
  checkMissingAgents,
  checkOrphanRoutes,
  checkDuplicatePeers,
  checkSelfPeer,
} from "./fleet-doctor-checks";
export type { FleetEntryLike } from "./fleet-doctor-checks-repo";
export { checkMissingRepos } from "./fleet-doctor-checks-repo";
export { checkStalePeers } from "./fleet-doctor-stale-peers";
export { autoFix } from "./fleet-doctor-fixer";

import { join } from "path";
import { loadConfig } from "../../config";
import { getGhqRoot } from "../../config/ghq-root";
import { listSessions } from "../../sdk";
import { loadFleetEntries } from "./fleet-load";
import {
  checkCollisions,
  checkOrphanRoutes,
  checkDuplicatePeers,
  checkSelfPeer,
  checkMissingAgents,
} from "./fleet-doctor-checks";
import { checkMissingRepos } from "./fleet-doctor-checks-repo";
import { checkStalePeers } from "./fleet-doctor-stale-peers";
import { autoFix, C, colorFor, iconFor } from "./fleet-doctor-fixer";
import type { DoctorFinding, Level } from "./fleet-doctor-checks";

interface DoctorOptions {
  fix?: boolean;
  json?: boolean;
}

export async function cmdFleetDoctor(opts: DoctorOptions = {}): Promise<void> {
  const config = loadConfig();
  const localNode = config.node || "local";
  const peers = config.namedPeers || [];
  const agents = config.agents || {};

  let entries: Array<{ session: { name: string; windows: Array<{ repo?: string }> } }> = [];
  try {
    entries = loadFleetEntries().map((e) => ({
      session: { name: e.session.name, windows: e.session.windows },
    }));
  } catch { /* fleet dir may not exist on fresh nodes */ }

  let sessionNames: string[] = [];
  try {
    const sessions = await listSessions();
    sessionNames = sessions.map((s) => s.name);
  } catch { /* no tmux server — checks that need sessions will simply find nothing */ }

  const findings: DoctorFinding[] = [];
  findings.push(...checkCollisions(sessionNames, peers.map((p) => p.name)));
  findings.push(...checkOrphanRoutes(agents, peers.map((p) => p.name), localNode));
  findings.push(...checkDuplicatePeers(peers));
  findings.push(...checkSelfPeer(peers, localNode, config.port));
  findings.push(...checkMissingRepos(entries, join(getGhqRoot(), "github.com")));

  const { findings: staleFindings, identities } = await checkStalePeers(peers);
  findings.push(...staleFindings);

  const peerAgents: Record<string, string[]> = {};
  for (const id of Object.values(identities)) {
    peerAgents[id.node] = id.agents;
  }
  findings.push(...checkMissingAgents(agents, peerAgents));

  if (opts.json) {
    console.log(JSON.stringify({ node: localNode, findings }, null, 2));
    const fatal = findings.some((f) => f.level === "error");
    process.exit(fatal ? 2 : findings.length > 0 ? 1 : 0);
  }

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");
  const infos = findings.filter((f) => f.level === "info");

  console.log();
  console.log(
    `  ${C.blue}${C.bold}🩺 Fleet Doctor${C.reset}  ${C.gray}node: ${localNode} · ${peers.length} peers · ${Object.keys(agents).length} agents · ${sessionNames.length} sessions${C.reset}`,
  );
  console.log();

  if (findings.length === 0) {
    console.log(`  ${C.green}✓${C.reset} No issues found. Fleet config is healthy.`);
    console.log();
    process.exit(0);
  }

  const byCheck = new Map<string, DoctorFinding[]>();
  for (const f of findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check)!.push(f);
  }
  for (const [check, items] of byCheck) {
    const level = items[0].level;
    console.log(`  ${colorFor(level)}${iconFor(level)}${C.reset} ${C.bold}${check}${C.reset} ${C.gray}(${items.length})${C.reset}`);
    for (const f of items) {
      console.log(`     ${f.message}`);
    }
    console.log();
  }

  if (opts.fix) {
    const fixed = autoFix(findings, config);
    if (fixed.length > 0) {
      console.log(`  ${C.green}✓${C.reset} Applied ${fixed.length} automatic fix${fixed.length === 1 ? "" : "es"}:`);
      for (const msg of fixed) console.log(`     - ${msg}`);
      console.log();
    } else {
      console.log(`  ${C.gray}No automatic fixes available — remaining issues need a human.${C.reset}`);
      console.log();
    }
  } else if (findings.some((f) => f.fixable)) {
    console.log(`  ${C.gray}Rerun with --fix to apply safe automatic fixes.${C.reset}`);
    console.log();
  }

  console.log(
    `  ${C.gray}${errors.length} error${errors.length === 1 ? "" : "s"} · ${warnings.length} warning${warnings.length === 1 ? "" : "s"} · ${infos.length} info${C.reset}`,
  );
  console.log();

  const exitCode = errors.length > 0 ? 2 : warnings.length > 0 ? 1 : 0;
  process.exit(exitCode);
}
