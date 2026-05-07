/**
 * Stall detection for tmux panes — Phase A (notify-only) of #976.
 *
 * Watches one or more panes by hashing the tail of `tmux capture-pane`
 * output every `intervalMs`. When N consecutive samples produce the
 * same hash (no visible change), the pane is reported as stalled.
 *
 * Phase A is NOTIFY-ONLY: we log a warning, never inject keys.
 * Phase B (issue #976B) adds gated auto-nudge with 4 safety gates.
 *
 * The core logic (`updateStallState`) is a pure function over a state
 * map, so unit tests don't need to mock tmux. The async runner
 * (`cmdStallDetect`) wires it to `cmdTmuxPeek` + a setInterval loop.
 */

import { createHash } from "node:crypto";
import { hostExec } from "../../../sdk";
import { resolveTmuxTarget } from "./impl";

export interface StallDetectOpts {
  /** Keep watching forever. Default: false (one-shot single sample). */
  watch?: boolean;
  /** Consecutive unchanged samples before reporting stall. Default: 3. */
  threshold?: number;
  /** Interval between samples in ms. Default: 30_000. */
  intervalMs?: number;
  /** Lines from bottom of pane to hash. Default: 30. */
  lines?: number;
}

export interface PaneSample {
  hash: string;
  unchanged: number;  // consecutive unchanged sample count
  notified: boolean;  // already notified for this stall window
}

export type StallState = Map<string, PaneSample>;

export interface StallEvent {
  paneId: string;
  hash: string;
  unchanged: number;
  /** First time we've crossed the threshold for this stall window. */
  firstReport: boolean;
}

/**
 * Pure state-update step. Given the previous state, a pane id, and
 * the new captured content, return the next state plus an optional
 * event when the pane is stalled.
 *
 * Caller decides what to do with the event (log, audit, nudge — Phase B).
 *
 * Reset rule: if the hash differs from the prior sample, `unchanged`
 * goes back to 1 and `notified` clears (next stall counts again).
 */
export function updateStallState(
  state: StallState,
  paneId: string,
  content: string,
  threshold: number,
): { state: StallState; event: StallEvent | null } {
  const hash = createHash("sha1").update(content).digest("hex");
  const prev = state.get(paneId);
  const next: StallState = new Map(state);

  if (!prev || prev.hash !== hash) {
    next.set(paneId, { hash, unchanged: 1, notified: false });
    return { state: next, event: null };
  }

  const unchanged = prev.unchanged + 1;
  const stalled = unchanged >= threshold;
  const firstReport = stalled && !prev.notified;
  next.set(paneId, { hash, unchanged, notified: prev.notified || stalled });

  if (!stalled) return { state: next, event: null };
  return { state: next, event: { paneId, hash, unchanged, firstReport } };
}

/** Format a stall notification for the console. Phase A: notify only. */
export function formatStallNotice(event: StallEvent, intervalMs: number): string {
  const seconds = Math.round((event.unchanged * intervalMs) / 1000);
  const tag = event.firstReport ? "STALL" : "still stalled";
  return `\x1b[33m⚠ ${tag}\x1b[0m ${event.paneId} — ${event.unchanged} unchanged samples (~${seconds}s) · hash ${event.hash.slice(0, 8)}`;
}

/**
 * CLI entry point. Captures one (or `--watch` many) sample per target
 * and prints stall notices. Phase A — never injects keys.
 */
export async function cmdStallDetect(
  targets: string[],
  opts: StallDetectOpts = {},
): Promise<void> {
  const threshold = opts.threshold ?? 3;
  const intervalMs = opts.intervalMs ?? 30_000;
  const lines = opts.lines ?? 30;

  const resolved = targets.map(t => {
    const hit = resolveTmuxTarget(t);
    if (!hit) throw new Error(`cannot resolve target '${t}'`);
    return { user: t, id: hit.resolved };
  });

  let state: StallState = new Map();

  const sampleOnce = async (): Promise<void> => {
    for (const { user, id } of resolved) {
      let out: string;
      try {
        out = await hostExec(`tmux capture-pane -pt '${id}' -S -${lines} -J`);
      } catch (e: any) {
        console.log(`\x1b[31m✗\x1b[0m ${user} (${id}): capture failed — ${e?.message || e}`);
        continue;
      }
      const result = updateStallState(state, id, out, threshold);
      state = result.state;
      if (result.event) {
        console.log(formatStallNotice(result.event, intervalMs));
      }
    }
  };

  await sampleOnce();
  if (!opts.watch) return;

  console.log(`\x1b[90m▸ watching ${resolved.length} pane(s) every ${intervalMs}ms (threshold=${threshold}) — notify-only\x1b[0m`);
  await new Promise<void>(() => {
    setInterval(() => { void sampleOnce(); }, intervalMs);
  });
}
