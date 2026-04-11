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
 */

import { existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import type { PeerConfig, MawConfig } from "../config";
import { listSessions } from "../ssh";
import { curlFetch } from "../curl-fetch";
import { loadFleetEntries } from "./fleet-load";

/**
 * Lazy save-config shim. Imported at call time rather than top-of-module so
 * bun's global mock.module() (used by peers.test.ts et al. to stub the config
 * module) doesn't break unrelated test files that load this module
 * transitively. The stub in test/helpers/mock-config.ts only exposes a
 * subset of the config API.
 */
function defaultSave(update: Partial<MawConfig>): void {
  const mod = require("../config") as typeof import("../config");
  mod.saveConfig(update);
}

export type Level = "error" | "warn" | "info";

export interface DoctorFinding {
  level: Level;
  check: string;
  message: string;
  fixable: boolean;
  detail?: Record<string, unknown>;
}

// ---------- Pure checks (unit-testable) ----------

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
 * Check 6 — Fleet entries whose primary repo is not in ghq.
 * #237 added clone-from-GitHub fallback, so this is informational, not fatal.
 */
export interface FleetEntryLike {
  session: { name: string; windows: Array<{ repo?: string }> };
}

export function checkMissingRepos(entries: FleetEntryLike[], ghqRoot: string): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const e of entries) {
    const repo = e.session.windows[0]?.repo;
    if (!repo) continue;
    // detectGhqRoot() may return the github.com-rooted path OR the bare ghq root.
    // Probe both to avoid false positives across machines.
    const direct = join(ghqRoot, repo);
    const nested = join(ghqRoot, "github.com", repo);
    if (!existsSync(direct) && !existsSync(nested)) {
      findings.push({
        level: "info",
        check: "missing-repo",
        fixable: false,
        message: `fleet '${e.session.name}' references repo '${repo}' not present in ghq — wake will clone from GitHub (#237)`,
        detail: { session: e.session.name, repo, paths: [direct, nested] },
      });
    }
  }
  return findings;
}

// ---------- I/O check (network) ----------

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
        const res = await curlFetch(`${p.url}/api/identity`, { timeout });
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

// ---------- CLI ----------

const C = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function colorFor(level: Level): string {
  return level === "error" ? C.red : level === "warn" ? C.yellow : C.blue;
}

function iconFor(level: Level): string {
  return level === "error" ? "✖" : level === "warn" ? "⚠" : "ℹ";
}

export interface DoctorOptions {
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
  findings.push(...checkMissingRepos(entries, config.ghqRoot));

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

/**
 * Apply safe auto-fixes: dedupe peers, remove self-peers, add missing agents
 * where the peer is unambiguous. Other findings (collision, orphan-route)
 * need a human — we won't rename sessions or invent routes.
 *
 * Returns human-readable descriptions of what was fixed. Invokes `save` with
 * the partial update when anything changes. `save` defaults to the real
 * `saveConfig` — tests pass a no-op (or a spy) to avoid touching disk and to
 * avoid using bun's global mock.module() machinery.
 */
export function autoFix(
  findings: DoctorFinding[],
  config: MawConfig,
  save: (update: Partial<MawConfig>) => void = defaultSave,
): string[] {
  const applied: string[] = [];
  const currentPeers = config.namedPeers || [];
  const currentAgents = { ...(config.agents || {}) };
  let touched = false;

  // 1. Dedupe peers (keep first occurrence by name, then by URL)
  const seenNames = new Set<string>();
  const seenUrls = new Set<string>();
  const deduped: PeerConfig[] = [];
  for (const p of currentPeers) {
    if (seenNames.has(p.name)) {
      applied.push(`removed duplicate peer '${p.name}'`);
      touched = true;
      continue;
    }
    if (seenUrls.has(p.url)) {
      applied.push(`removed duplicate peer URL '${p.url}' (was '${p.name}')`);
      touched = true;
      continue;
    }
    seenNames.add(p.name);
    seenUrls.add(p.url);
    deduped.push(p);
  }

  // 2. Remove self-peers
  const localNode = config.node || "";
  const localPort = config.port;
  const noSelf = deduped.filter((p) => {
    if (localNode && p.name === localNode) {
      applied.push(`removed self-peer '${p.name}' (matches local node)`);
      touched = true;
      return false;
    }
    try {
      const u = new URL(p.url);
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      if (
        port === localPort &&
        (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0")
      ) {
        applied.push(`removed self-peer '${p.name}' (URL points to self)`);
        touched = true;
        return false;
      }
    } catch { /* ignore */ }
    return true;
  });

  // 3. Auto-add missing agents
  for (const f of findings) {
    if (f.check !== "missing-agent" || !f.fixable || !f.detail) continue;
    const oracle = f.detail.oracle as string | undefined;
    const peerNode = f.detail.peerNode as string | undefined;
    if (oracle && peerNode && !currentAgents[oracle]) {
      currentAgents[oracle] = peerNode;
      applied.push(`added config.agents['${oracle}'] = '${peerNode}'`);
      touched = true;
    }
  }

  if (touched) {
    save({ namedPeers: noSelf, agents: currentAgents });
  }
  return applied;
}
