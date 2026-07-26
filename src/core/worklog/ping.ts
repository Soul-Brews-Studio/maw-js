/**
 * Active ping — surface a state change to whoever holds stale state, carrying the
 * actual content ("เนื้อ") so they can act/object. Delivery is `maw hey`, which
 * already does pane-poke + inbox fallback + wake-if-asleep.
 *
 * Sender is injected (testable). Default fires a detached `maw hey` subprocess so
 * delivery failure stays isolated from the calling CLI/poller/hook.
 */

import { scopeOfOracle } from "./company-scope";
import { spawnHeyProcess } from "../tasks/hey-spawn";

export interface PingDeps {
  send: (target: string, message: string) => void;
}

const defaultSend = (target: string, message: string) => {
  try {
    spawnHeyProcess([target, message]); // kobo-405: shared fail-closed-under-test seam
  } catch {
    /* best effort — the worklog entry still records the event */
  }
};

export const defaultPingDeps: PingDeps = { send: defaultSend };

function deliver(targets: Iterable<string>, message: string, deps: PingDeps): string[] {
  const seen = new Set<string>();
  const sent: string[] = [];
  for (const t of targets) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    deps.send(t, message);
    sent.push(t);
  }
  return sent;
}

export interface PingOnMergeOpts {
  lead?: string | null;
  author?: string | null;
  pr: number;
  repo: string;
  by?: string;
}

/** Notify lead + author about a merge. Returns pinged targets. */
export function pingOnMerge(opts: PingOnMergeOpts, deps: PingDeps = defaultPingDeps): string[] {
  const msg = `[watch] PR #${opts.pr} (${opts.repo}) merged${opts.by ? ` by ${opts.by}` : ""} — sync your state`;
  return deliver([opts.lead, opts.author].filter(Boolean) as string[], msg, deps);
}

/** Notify the other claimant(s) of a same-task collision. */
export function pingCollision(
  oracle: string,
  task: string,
  others: string[],
  deps: PingDeps = defaultPingDeps,
): string[] {
  const msg = `[watch] ${oracle} just claimed "${task}" — you have an overlapping open claim. Coordinate to avoid double work.`;
  return deliver(others, msg, deps);
}

/**
 * Bypass note — Tony talked to a worker directly; tell the worker's lead WITH the
 * content so the lead can object. Heuristic detection lives at the call site; this
 * just delivers once a bypass is identified.
 */
export function pingBypass(worker: string, content: string, deps: PingDeps = defaultPingDeps): string[] {
  const lead = scopeOfOracle(worker)?.lead;
  if (!lead || lead === worker) return [];
  const msg = `[watch] direct instruction to worker ${worker}: "${content}" — heads up (you can object)`;
  return deliver([lead], msg, deps);
}
