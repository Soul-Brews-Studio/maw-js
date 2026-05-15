/**
 * fleet-doctor-fixer — color/icon helpers and the autoFix function.
 *
 * autoFix applies safe automatic remediation: dedup peers, remove self-peers,
 * add missing agent entries. It does NOT rename sessions or invent routes —
 * those need a human.
 */

import type { MawConfig, PeerConfig } from "../../config";
import type { DoctorFinding, Level } from "./fleet-doctor-checks";

// ---------- Color/icon helpers ----------

export const C = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

export function colorFor(level: Level): string {
  return level === "error" ? C.red : level === "warn" ? C.yellow : C.blue;
}

export function iconFor(level: Level): string {
  return level === "error" ? "✖" : level === "warn" ? "⚠" : "ℹ";
}

// ---------- Lazy save-config shim ----------

/**
 * Lazy save-config shim. Imported at call time rather than top-of-module so
 * bun's global mock.module() (used by peers.test.ts et al. to stub the config
 * module) doesn't break unrelated test files that load this module
 * transitively. The stub in test/helpers/mock-config.ts only exposes a
 * subset of the config API.
 */
export function defaultSave(update: Partial<MawConfig>): void {
  const mod = require("../../config") as typeof import("../../config");
  mod.saveConfig(update);
}

// ---------- Auto-fixer ----------

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

  // 3. Remove agents that shadow namedPeers (#1323 / #1326)
  for (const f of findings) {
    if (f.check !== "agent-peer-shadow" || !f.fixable || !f.detail) continue;
    const agentName = f.detail.agentName as string | undefined;
    if (agentName && currentAgents[agentName]) {
      delete currentAgents[agentName];
      applied.push(`removed config.agents['${agentName}'] (was shadowing namedPeer '${f.detail.peerName}')`);
      touched = true;
    }
  }

  // 4. Auto-add missing agents
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
