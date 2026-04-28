/**
 * comm-peek.ts — cmdPeek + resolveSearchSessions + remote federation peek.
 */

import { listSessions, capture, findWindow, curlFetch } from "../../sdk";
import { loadConfig } from "../../config";
import { resolveFleetSession } from "./wake";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import type { SshSession as Session } from "../../sdk";

/** Resolve which sessions to search for an oracle query (#86). */
/** @internal */
export function resolveSearchSessions(query: string, sessions: Session[]): Session[] {
  const config = loadConfig();
  // 1. Check config.sessions mapping
  const mapped = (config.sessions as Record<string, string>)?.[query];
  if (mapped) {
    const filtered = sessions.filter(s => s.name === mapped);
    if (filtered.length > 0) return filtered;
  }
  // 2. Check fleet configs for oracle → session mapping
  const fleetSession = resolveFleetSession(query);
  if (fleetSession) {
    const filtered = sessions.filter(s => s.name === fleetSession);
    if (filtered.length > 0) return filtered;
  }
  // 3. Fallback: search all
  return sessions;
}

export async function cmdPeek(query?: string) {
  // Canonicalize first — strip trailing `/`, `/.git`, `/.git/` tab-completion artifacts.
  // Preserve undefined (no-arg case prints the fleet overview).
  if (query !== undefined) query = normalizeTarget(query);
  const config = loadConfig();

  // #362b — inform users when they omit the node prefix. Canonical form is
  // `<node>:<oracle>` (matches contacts.json). Bare name works for local
  // peek but scripts should use the prefixed form for fleet portability.
  // Silent when MAW_QUIET=1.
  if (query && !query.includes(":") && !query.includes("/") && !process.env.MAW_QUIET && config.node) {
    console.error(`\x1b[90mℹ tip: use canonical form 'maw peek ${config.node}:${query}' for cross-node scripts (bare name resolves locally)\x1b[0m`);
  }

  // Node prefix: "white:neo-maw-js" → peek remote agent via federation
  if (query && query.includes(":") && !query.includes("/")) {
    const [nodeName, agentName] = query.split(":", 2);
    const localNode = config.node || "local";
    if (nodeName === localNode) {
      // #362 — local node prefix: strip and fall through to local peek
      query = agentName;
    } else {
      const peer = config.namedPeers?.find(p => p.name === nodeName);
      const peerUrl = peer?.url || config.peers?.find(p => p.includes(nodeName));
      if (peerUrl) {
        const res = await curlFetch(`${peerUrl}/api/capture?target=${encodeURIComponent(agentName)}`);
        if (res.ok && res.data?.content) {
          console.log(`\x1b[36m--- ${nodeName}:${agentName} (${nodeName}) ---\x1b[0m`);
          console.log(res.data.content);
          return;
        }
        console.error(`\x1b[31merror\x1b[0m: capture failed for ${agentName} on ${nodeName}${res.data?.error ? `: ${res.data.error}` : ""}`);
        process.exit(1);
      }
    }
  }

  const sessions = await listSessions();

  // #835 — peek's policy is "never auto-wake" (read-only by design). The
  // unified shouldAutoWake() helper is consulted for transparency: if the
  // policy ever changes, the call site is already wired in.
  if (query) {
    const { shouldAutoWake } = await import("./should-auto-wake");
    const decision = shouldAutoWake(query, { site: "peek" });
    if (decision.wake) {
      // Defensive: site=peek always returns wake=false. If a future helper
      // change flips this, we'd need to choose how peek handles a wake; for
      // now we explicitly do nothing (preserve historical behavior) but log.
      console.error(`\x1b[33mwarn\x1b[0m: shouldAutoWake suggested wake but peek refuses (${decision.reason})`);
    }
  }

  if (!query) {
    // Peek all — one line per agent
    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        try {
          const content = await capture(target, 3);
          const lastLine = content.split("\n").filter(l => l.trim()).pop() || "(empty)";
          const dot = w.active ? "\x1b[32m*\x1b[0m" : " ";
          console.log(`${dot} \x1b[36m${w.name.padEnd(22)}\x1b[0m ${lastLine.slice(0, 80)}`);
        } catch {
          console.log(`  \x1b[36m${w.name.padEnd(22)}\x1b[0m (unreachable)`);
        }
      }
    }
    return;
  }
  const searchIn = resolveSearchSessions(query, sessions);
  const target = findWindow(searchIn, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }
  const content = await capture(target);
  console.log(`\x1b[36m--- ${target} ---\x1b[0m`);
  console.log(content);
}
