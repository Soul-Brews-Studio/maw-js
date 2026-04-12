/**
 * maw federation sync — active companion to `maw fleet doctor`.
 *
 * Fleet doctor diagnoses config drift. Federation sync *treats* the biggest
 * class of drift — the one that mawui caught tonight — by pulling live
 * identities from every namedPeer's /api/identity and populating the local
 * `config.agents` map automatically.
 *
 * Manually maintained config.agents is the reason `maw hey volt-colab-ml`
 * failed tonight: white grew a new oracle and oracle-world didn't know about
 * it. After this command, any fleet growth on any peer propagates by running
 * `maw federation sync`.
 *
 * Conservative by default: does not overwrite existing routes, does not
 * remove entries (use --prune). --force is required to change a route
 * that already points to a different node.
 *
 * The diff function is pure (no network, no filesystem) so tests can cover
 * every edge case exhaustively without mocking.
 */

import { loadConfig, cfgTimeout } from "../config";
import type { MawConfig, PeerConfig } from "../config";
import { curlFetch } from "../curl-fetch";

// ---------- Pure identity helpers ----------

/**
 * Compute the set of oracles this node claims to host locally.
 *
 * Pure — lives here (not in src/api/federation.ts) so tests can import it
 * without pulling in the full API module and its `../snapshot` chain. Under
 * bun 1.3.10's stricter mock isolation, importing from api/federation was
 * transitively loading snapshot.ts before snapshot.test.ts could mock paths,
 * which caused CI-only snapshot test failures.
 *
 * We accept TWO conventions in config.agents:
 *   - `'<nodeName>'` — explicit ("white")
 *   - `'local'`     — shorthand ("me, whoever I am")
 *
 * Both mean "hosted here" and both must be reported, otherwise peers running
 * `maw federation sync` will false-flag oracles as stale just because the
 * local node wrote `'local'` instead of its own node name. (Discovered on
 * 2026-04-11: `volt-colab-ml: 'local'` on white silently dropped, so
 * oracle-world saw a stale-delete it should never have seen.)
 */
export function hostedAgents(agents: Record<string, string>, node: string): string[] {
  return Object.entries(agents)
    .filter(([, n]) => n === node || n === "local")
    .map(([name]) => name);
}

// ---------- Types ----------

export interface PeerIdentity {
  /** namedPeer.name — what the user wrote in config */
  peerName: string;
  /** Peer's advertised URL */
  url: string;
  /** identity.node from /api/identity — the authoritative routing key */
  node: string;
  /** identity.agents — oracle names the peer hosts locally */
  agents: string[];
  /** Whether /api/identity responded with valid data */
  reachable: boolean;
  /** Error message if unreachable */
  error?: string;
}

export interface SyncDiff {
  /** Oracles present on a reachable peer but not in local config.agents */
  add: Array<{ oracle: string; peerNode: string; fromPeer: string }>;
  /** Oracles routed locally to node X, but peer X no longer hosts them */
  stale: Array<{ oracle: string; peerNode: string }>;
  /** Oracles routed locally to node X, but peer Y claims to host them too */
  conflict: Array<{
    oracle: string;
    current: string;
    proposed: string;
    fromPeer: string;
  }>;
  /** Peers we couldn't reach — their oracles are invisible to this sync */
  unreachable: Array<{ peerName: string; url: string; error?: string }>;
}

// ---------- Pure diff (unit-testable) ----------

/**
 * Compute what a sync would do without touching config or network.
 *
 * Rules:
 *  - 'local' routes are sacrosanct (never flag as conflict or stale)
 *  - A route pointing at our own localNode is treated like 'local'
 *  - Unreachable peers are skipped entirely — their routes are left alone
 *    because we can't prove anything about them right now
 *  - A new oracle on a reachable peer → add (unless already routed)
 *  - Existing route X → peer.node X, oracle still hosted → no-op (not in diff)
 *  - Existing route X → peer.node X, oracle no longer hosted → stale
 *  - Existing route X → but peer Y also claims it → conflict (first peer wins)
 */
export function computeSyncDiff(
  localAgents: Record<string, string>,
  peerIdentities: PeerIdentity[],
  localNode: string,
): SyncDiff {
  const diff: SyncDiff = { add: [], stale: [], conflict: [], unreachable: [] };

  const liveByNode = new Map<string, Set<string>>();
  const peerNameByNode = new Map<string, string>();

  for (const p of peerIdentities) {
    if (!p.reachable) {
      diff.unreachable.push({ peerName: p.peerName, url: p.url, error: p.error });
      continue;
    }
    // First peer wins on duplicate node name
    if (!liveByNode.has(p.node)) {
      liveByNode.set(p.node, new Set(p.agents));
      peerNameByNode.set(p.node, p.peerName);
    }
  }

  // ADD / CONFLICT — walk every live oracle.
  // Iterate in peerIdentities input order so "first peer wins" when two
  // different nodes both claim the same oracle.
  const claimedByFirst = new Set<string>();
  for (const p of peerIdentities) {
    if (!p.reachable) continue;
    const peerName = peerNameByNode.get(p.node);
    if (peerName !== p.peerName) continue; // a later duplicate node entry — already processed
    for (const oracle of p.agents) {
      if (claimedByFirst.has(oracle)) continue; // another peer already claimed this oracle
      claimedByFirst.add(oracle);
      if (!(oracle in localAgents)) {
        diff.add.push({ oracle, peerNode: p.node, fromPeer: peerName });
        continue;
      }
      const current = localAgents[oracle];
      if (current === "local" || current === localNode || current === p.node) {
        continue;
      }
      diff.conflict.push({
        oracle,
        current,
        proposed: p.node,
        fromPeer: peerName,
      });
    }
  }

  // STALE — walk every local route that points at a *reachable* peer node
  for (const [oracle, node] of Object.entries(localAgents)) {
    if (node === "local" || node === localNode) continue;
    const live = liveByNode.get(node);
    if (live && !live.has(oracle)) {
      diff.stale.push({ oracle, peerNode: node });
    }
  }

  return diff;
}

// ---------- I/O: fetch identities ----------

/**
 * Hit every namedPeer's /api/identity in parallel.
 * Always returns one PeerIdentity per peer — unreachable peers are marked,
 * not dropped, so the CLI can surface them.
 */
export async function fetchPeerIdentities(
  peers: PeerConfig[],
  timeout?: number,
): Promise<PeerIdentity[]> {
  const t = timeout ?? cfgTimeout("http");
  return Promise.all(
    peers.map(async (p): Promise<PeerIdentity> => {
      try {
        const res = await curlFetch(`${p.url}/api/identity`, { timeout: t });
        if (!res.ok || !res.data) {
          return {
            peerName: p.name,
            url: p.url,
            node: "",
            agents: [],
            reachable: false,
            error: `http ${res.status ?? "?"}`,
          };
        }
        const data = res.data as { node?: unknown; agents?: unknown };
        if (typeof data.node !== "string" || !Array.isArray(data.agents)) {
          return {
            peerName: p.name,
            url: p.url,
            node: "",
            agents: [],
            reachable: false,
            error: "invalid identity shape",
          };
        }
        const agents = data.agents.filter((a): a is string => typeof a === "string");
        return { peerName: p.name, url: p.url, node: data.node, agents, reachable: true };
      } catch (e: any) {
        return {
          peerName: p.name,
          url: p.url,
          node: "",
          agents: [],
          reachable: false,
          error: String(e?.message || e).split("\n")[0],
        };
      }
    }),
  );
}

// ---------- Apply: pure transform of config ----------

/**
 * Apply a diff to an agents map. Pure — no I/O. Returns the new map and a
 * list of human-readable descriptions of what changed.
 *
 * `force` allows overwriting conflicting routes.
 * `prune` allows removing stale entries.
 */
export function applySyncDiff(
  currentAgents: Record<string, string>,
  diff: SyncDiff,
  opts: { force?: boolean; prune?: boolean } = {},
): { agents: Record<string, string>; applied: string[] } {
  const agents = { ...currentAgents };
  const applied: string[] = [];

  for (const a of diff.add) {
    agents[a.oracle] = a.peerNode;
    applied.push(`+ agents['${a.oracle}'] = '${a.peerNode}'  (from peer '${a.fromPeer}')`);
  }

  if (opts.force) {
    for (const c of diff.conflict) {
      agents[c.oracle] = c.proposed;
      applied.push(
        `~ agents['${c.oracle}']: '${c.current}' → '${c.proposed}'  (from peer '${c.fromPeer}', --force)`,
      );
    }
  }

  if (opts.prune) {
    for (const s of diff.stale) {
      delete agents[s.oracle];
      applied.push(`- agents['${s.oracle}']  (was '${s.peerNode}', no longer hosted there)`);
    }
  }

  return { agents, applied };
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

export interface SyncOptions {
  dryRun?: boolean;
  check?: boolean;
  prune?: boolean;
  force?: boolean;
  json?: boolean;
}

/**
 * Lazy save-config shim — same pattern as fleet-doctor, avoids breaking
 * tests that mock.module() the config module globally.
 */
function defaultSave(update: Partial<MawConfig>): void {
  const mod = require("../config") as typeof import("../config");
  mod.saveConfig(update);
}

export async function cmdFederationSync(
  opts: SyncOptions = {},
  save: (update: Partial<MawConfig>) => void = defaultSave,
): Promise<void> {
  const config = loadConfig();
  const localNode = config.node || "local";
  const peers = config.namedPeers || [];
  const agents = config.agents || {};

  if (peers.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ node: localNode, diff: null, reason: "no peers" }));
      process.exit(0);
    }
    console.log();
    console.log(`  ${C.gray}no namedPeers configured — nothing to sync${C.reset}`);
    console.log();
    process.exit(0);
  }

  const identities = await fetchPeerIdentities(peers);
  const diff = computeSyncDiff(agents, identities, localNode);

  if (opts.json) {
    console.log(JSON.stringify({ node: localNode, diff, dryRun: !!opts.dryRun }, null, 2));
    const dirty = diff.add.length + diff.stale.length + diff.conflict.length > 0;
    process.exit(opts.check && dirty ? 1 : 0);
  }

  console.log();
  console.log(
    `  ${C.blue}${C.bold}🔄 Federation Sync${C.reset}  ${C.gray}node: ${localNode} · ${peers.length} peers · ${Object.keys(agents).length} agents${C.reset}`,
  );
  console.log();

  // Per-peer section
  for (const id of identities) {
    const label = `${id.peerName} ${C.gray}(${id.url})${C.reset}`;
    if (!id.reachable) {
      console.log(`  ${C.yellow}!${C.reset} ${label}  ${C.gray}unreachable${id.error ? ` — ${id.error}` : ""}${C.reset}`);
      continue;
    }
    const adds = diff.add.filter((a) => a.fromPeer === id.peerName);
    const confs = diff.conflict.filter((c) => c.fromPeer === id.peerName);
    const stale = diff.stale.filter((s) => s.peerNode === id.node);
    console.log(`  ${C.green}●${C.reset} ${label}  ${C.gray}node=${id.node} · ${id.agents.length} oracles${C.reset}`);
    for (const a of adds) {
      console.log(`      ${C.green}+${C.reset} ${a.oracle}  ${C.gray}→ ${a.peerNode}${C.reset}`);
    }
    for (const c of confs) {
      console.log(
        `      ${C.yellow}~${C.reset} ${c.oracle}  ${C.gray}currently ${c.current}, peer claims ${c.proposed}${C.reset}`,
      );
    }
    for (const s of stale) {
      console.log(`      ${C.red}-${C.reset} ${s.oracle}  ${C.gray}no longer hosted on ${s.peerNode}${C.reset}`);
    }
  }
  console.log();

  const dirty = diff.add.length + diff.stale.length + diff.conflict.length > 0;

  if (!dirty) {
    console.log(`  ${C.green}✓${C.reset} in sync. ${C.gray}(${diff.unreachable.length} peers unreachable)${C.reset}`);
    console.log();
    process.exit(0);
  }

  // Conflicts block apply unless --force
  if (diff.conflict.length > 0 && !opts.force && !opts.dryRun && !opts.check) {
    console.log(
      `  ${C.yellow}${diff.conflict.length} conflict${diff.conflict.length === 1 ? "" : "s"}${C.reset} — rerun with ${C.bold}--force${C.reset} to overwrite existing routes.`,
    );
    console.log();
    process.exit(2);
  }

  // Stale entries won't be removed unless --prune
  if (diff.stale.length > 0 && !opts.prune && !opts.dryRun && !opts.check) {
    console.log(
      `  ${C.gray}${diff.stale.length} stale entr${diff.stale.length === 1 ? "y" : "ies"} — rerun with ${C.bold}--prune${C.reset}${C.gray} to remove${C.reset}`,
    );
  }

  if (opts.check) {
    console.log(
      `  ${C.yellow}✖${C.reset} out of sync: ${diff.add.length} add · ${diff.conflict.length} conflict · ${diff.stale.length} stale`,
    );
    console.log();
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log(`  ${C.gray}dry run — no changes written${C.reset}`);
    console.log();
    process.exit(0);
  }

  // Apply
  const { agents: nextAgents, applied } = applySyncDiff(agents, diff, {
    force: opts.force,
    prune: opts.prune,
  });

  if (applied.length > 0) {
    save({ agents: nextAgents });
    console.log(`  ${C.green}✓${C.reset} applied ${applied.length} change${applied.length === 1 ? "" : "s"}:`);
    for (const msg of applied) console.log(`     ${msg}`);
    console.log();
  } else {
    console.log(`  ${C.gray}no changes applied (use --force / --prune)${C.reset}`);
    console.log();
  }

  process.exit(0);
}
