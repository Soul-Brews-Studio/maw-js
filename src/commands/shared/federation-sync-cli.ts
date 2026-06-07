/**
 * federation-sync-cli.ts — CLI formatting + cmdFederationSync entry point.
 */

import { loadConfig } from "../../config";
import type { MawConfig } from "../../config";
import { fetchPeerIdentities } from "./federation-fetch";
import { computeSyncDiff } from "./federation-diff";
import { applySyncDiff } from "./federation-apply";
import {
  peerTargetsToConfigs,
  resolvePeerSources,
  type PeerSourceMode,
} from "./peer-sources";

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
  peers?: PeerSourceMode;
}

export interface FederationSyncDeps {
  loadConfig: () => MawConfig;
  fetchPeerIdentities: typeof fetchPeerIdentities;
  computeSyncDiff: typeof computeSyncDiff;
  applySyncDiff: typeof applySyncDiff;
  resolvePeerSources: typeof resolvePeerSources;
  log: (...args: unknown[]) => void;
  exit: (code?: number) => never;
}

export function federationSyncDeps(overrides: Partial<FederationSyncDeps> = {}): FederationSyncDeps {
  return {
    loadConfig,
    fetchPeerIdentities,
    computeSyncDiff,
    applySyncDiff,
    resolvePeerSources,
    log: (...args: unknown[]) => console.log(...args),
    exit: (code?: number): never => process.exit(code),
    ...overrides,
  };
}

/**
 * Lazy save-config shim — same pattern as fleet-doctor, avoids breaking
 * tests that mock.module() the config module globally.
 */
function defaultSave(update: Partial<MawConfig>): void {
  const mod = require("../../config") as typeof import("../../config");
  mod.saveConfig(update);
}

export async function cmdFederationSync(
  opts: SyncOptions = {},
  save: (update: Partial<MawConfig>) => void = defaultSave,
  deps: Partial<FederationSyncDeps> = {},
): Promise<void> {
  const io = federationSyncDeps(deps);
  const config = io.loadConfig();
  const localNode = config.node || "local";
  const peerSource = await io.resolvePeerSources(config, opts.peers ?? "config");
  const peers = peerTargetsToConfigs(peerSource.peers);
  const agents = config.agents || {};

  if (peers.length === 0) {
    if (opts.json) {
      io.log(JSON.stringify({
        node: localNode,
        diff: null,
        reason: "no peers",
        ...(peerSource.warnings.length > 0 ? { peerWarnings: peerSource.warnings } : {}),
      }));
      io.exit(0);
    }
    io.log();
    for (const warning of peerSource.warnings) {
      io.log(`  ${C.yellow}!${C.reset} ${C.gray}${warning}${C.reset}`);
    }
    const sourceLabel = (opts.peers ?? "config") === "config" ? "namedPeers configured" : "peers configured or discovered";
    io.log(`  ${C.gray}no ${sourceLabel} — nothing to sync${C.reset}`);
    io.log();
    io.exit(0);
  }

  const identities = await io.fetchPeerIdentities(peers);
  const diff = io.computeSyncDiff(agents, identities, localNode);

  if (opts.json) {
    io.log(JSON.stringify({
      node: localNode,
      diff,
      dryRun: !!opts.dryRun,
      ...(peerSource.warnings.length > 0 ? { peerWarnings: peerSource.warnings } : {}),
    }, null, 2));
    const dirty = diff.add.length + diff.stale.length + diff.conflict.length > 0;
    io.exit(opts.check && dirty ? 1 : 0);
  }

  io.log();
  for (const warning of peerSource.warnings) {
    io.log(`  ${C.yellow}!${C.reset} ${C.gray}${warning}${C.reset}`);
  }
  if (peerSource.warnings.length > 0) io.log();
  io.log(
    `  ${C.blue}${C.bold}🔄 Federation Sync${C.reset}  ${C.gray}node: ${localNode} · ${peers.length} peers · ${Object.keys(agents).length} agents${C.reset}`,
  );
  io.log();

  // Per-peer section
  for (const id of identities) {
    const label = `${id.peerName} ${C.gray}(${id.url})${C.reset}`;
    if (!id.reachable) {
      io.log(`  ${C.yellow}!${C.reset} ${label}  ${C.gray}unreachable${id.error ? ` — ${id.error}` : ""}${C.reset}`);
      continue;
    }
    const adds = diff.add.filter((a) => a.fromPeer === id.peerName);
    const confs = diff.conflict.filter((c) => c.fromPeer === id.peerName);
    const stale = diff.stale.filter((s) => s.peerNode === id.node);
    io.log(`  ${C.green}●${C.reset} ${label}  ${C.gray}node=${id.node} · ${id.agents.length} oracles${C.reset}`);
    for (const a of adds) {
      io.log(`      ${C.green}+${C.reset} ${a.oracle}  ${C.gray}→ ${a.peerNode}${C.reset}`);
    }
    for (const c of confs) {
      io.log(
        `      ${C.yellow}~${C.reset} ${c.oracle}  ${C.gray}currently ${c.current}, peer claims ${c.proposed}${C.reset}`,
      );
    }
    for (const s of stale) {
      io.log(`      ${C.red}-${C.reset} ${s.oracle}  ${C.gray}no longer hosted on ${s.peerNode}${C.reset}`);
    }
  }
  io.log();

  const dirty = diff.add.length + diff.stale.length + diff.conflict.length > 0;

  if (!dirty) {
    io.log(`  ${C.green}✓${C.reset} in sync. ${C.gray}(${diff.unreachable.length} peers unreachable)${C.reset}`);
    io.log();
    io.exit(0);
  }

  // Conflicts block apply unless --force
  if (diff.conflict.length > 0 && !opts.force && !opts.dryRun && !opts.check) {
    io.log(
      `  ${C.yellow}${diff.conflict.length} conflict${diff.conflict.length === 1 ? "" : "s"}${C.reset} — rerun with ${C.bold}--force${C.reset} to overwrite existing routes.`,
    );
    io.log();
    io.exit(2);
  }

  // Stale entries won't be removed unless --prune
  if (diff.stale.length > 0 && !opts.prune && !opts.dryRun && !opts.check) {
    io.log(
      `  ${C.gray}${diff.stale.length} stale entr${diff.stale.length === 1 ? "y" : "ies"} — rerun with ${C.bold}--prune${C.reset}${C.gray} to remove${C.reset}`,
    );
  }

  if (opts.check) {
    io.log(
      `  ${C.yellow}✖${C.reset} out of sync: ${diff.add.length} add · ${diff.conflict.length} conflict · ${diff.stale.length} stale`,
    );
    io.log();
    io.exit(1);
  }

  if (opts.dryRun) {
    io.log(`  ${C.gray}dry run — no changes written${C.reset}`);
    io.log();
    io.exit(0);
  }

  // Apply
  const { agents: nextAgents, applied } = io.applySyncDiff(agents, diff, {
    force: opts.force,
    prune: opts.prune,
  });

  if (applied.length > 0) {
    save({ agents: nextAgents });
    io.log(`  ${C.green}✓${C.reset} applied ${applied.length} change${applied.length === 1 ? "" : "s"}:`);
    for (const msg of applied) io.log(`     ${msg}`);
    io.log();
  } else {
    io.log(`  ${C.gray}no changes applied (use --force / --prune)${C.reset}`);
    io.log();
  }

  io.exit(0);
}
