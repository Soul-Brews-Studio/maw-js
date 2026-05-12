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

// ─── Phase B: one-shot stall detection with gated auto-nudge (#976) ──────────

const EDITOR_REPL_CMDS = new Set(["vim", "nano", "emacs", "node", "python", "python3", "psql", "irb"]);

interface NudgeGateResult {
  safe: boolean;
  reason?: string;
}

function checkNudgeGates(lastLine: string, paneCmd: string): NudgeGateResult {
  // Gate 1: password prompt
  if (/password:|passphrase:|\[sudo\]|pin:/i.test(lastLine))
    return { safe: false, reason: "gate 1: password prompt" };
  // Gate 2: editor or REPL running
  const bare = paneCmd.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (EDITOR_REPL_CMDS.has(bare))
    return { safe: false, reason: "gate 2: editor/REPL" };
  // Gate 3: claude mid-turn (braille spinner, "Thinking", ⏺ marker)
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|thinking|⏺/i.test(lastLine))
    return { safe: false, reason: "gate 3: claude mid-turn" };
  // Gate 4: interactive prompt (trailing ? or numbered options 1), 2) …)
  if (/\?\s*$|\b[1-9]\)/.test(lastLine))
    return { safe: false, reason: "gate 4: interactive prompt" };
  return { safe: true };
}

interface PaneStallResult {
  display: string;
  id: string;
  stalled: boolean;
  nudgeBlocked?: string;
  nudged?: boolean;
}

/**
 * One-shot stall detection with optional gated auto-nudge.
 *
 * Algorithm:
 *   1. Capture last 5 lines from each target pane.
 *   2. Wait 3 seconds.
 *   3. Capture again — unchanged content → stall detected.
 *   4. If --auto-nudge and all safety gates pass → send Enter.
 *
 * No targets → inspect every pane in the current tmux session.
 */
export async function cmdDetectStalls(targets?: string[], opts?: { autoNudge?: boolean }): Promise<void> {
  const autoNudge = opts?.autoNudge ?? false;

  // Resolve targets. No targets → all panes in current session.
  type Resolved = { display: string; id: string };
  let resolved: Resolved[];

  if (!targets || targets.length === 0) {
    let raw: string;
    try {
      raw = await hostExec("tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_id}'");
    } catch {
      console.log("\x1b[33m⚠\x1b[0m  not in a tmux session or tmux unavailable");
      return;
    }
    resolved = raw.trim().split("\n").filter(Boolean).map(line => {
      const [display, id] = line.trim().split(" ");
      return { display: display ?? line, id: id ?? display ?? line };
    });
  } else {
    resolved = targets.map(t => {
      const hit = resolveTmuxTarget(t);
      if (!hit) throw new Error(`cannot resolve target '${t}'`);
      return { display: t, id: hit.resolved };
    });
  }

  if (resolved.length === 0) {
    console.log("\x1b[90mno panes to inspect\x1b[0m");
    return;
  }

  // First capture
  const snap1 = new Map<string, string>();
  for (const { id } of resolved) {
    try {
      snap1.set(id, await hostExec(`tmux capture-pane -pt '${id}' -S -5 -J`));
    } catch {
      snap1.set(id, "");
    }
  }

  // Wait 3 seconds
  await new Promise<void>(r => setTimeout(r, 3000));

  // Second capture + evaluate
  const results: PaneStallResult[] = [];
  for (const { display, id } of resolved) {
    let snap2 = "";
    try {
      snap2 = await hostExec(`tmux capture-pane -pt '${id}' -S -5 -J`);
    } catch { /* pane gone */ }

    const before = snap1.get(id) ?? "";
    const stalled = before === snap2;

    if (!stalled) {
      results.push({ display, id, stalled: false });
      continue;
    }

    if (!autoNudge) {
      results.push({ display, id, stalled: true });
      continue;
    }

    // Get pane's current command for gate 2
    let paneCmd = "";
    try {
      paneCmd = (await hostExec(`tmux display-message -p -t '${id}' '#{pane_current_command}'`)).trim();
    } catch { /* ignore */ }

    const lastLine = snap2.trimEnd().split("\n").pop() ?? "";
    const gate = checkNudgeGates(lastLine, paneCmd);

    if (!gate.safe) {
      results.push({ display, id, stalled: true, nudgeBlocked: gate.reason });
      continue;
    }

    try {
      await hostExec(`tmux send-keys -t '${id}' '' Enter`);
      results.push({ display, id, stalled: true, nudged: true });
    } catch {
      results.push({ display, id, stalled: true, nudgeBlocked: "send-keys failed" });
    }
  }

  // Output
  console.log("\n\x1b[1m🔍 Stall Detection\x1b[0m\n");
  for (const r of results) {
    const label = r.display.padEnd(20);
    if (!r.stalled) {
      console.log(`  \x1b[32m●\x1b[0m ${label} active (output changing)`);
    } else {
      console.log(`  \x1b[33m⚠\x1b[0m ${label} STALLED (no output for 3s)`);
      if (autoNudge) {
        if (r.nudged) {
          console.log(`    \x1b[90m→ auto-nudge: sent Enter\x1b[0m`);
        } else if (r.nudgeBlocked) {
          console.log(`    \x1b[90m→ auto-nudge: blocked (${r.nudgeBlocked})\x1b[0m`);
        }
      }
    }
  }

  const active = results.filter(r => !r.stalled).length;
  const stalled = results.filter(r => r.stalled).length;
  const nudged = results.filter(r => r.nudged).length;
  const blocked = results.filter(r => r.stalled && !r.nudged).length;

  console.log();
  if (autoNudge && stalled > 0) {
    console.log(`\x1b[90mSummary: ${active} active, ${stalled} stalled (${nudged} nudged, ${blocked} blocked)\x1b[0m\n`);
  } else {
    console.log(`\x1b[90mSummary: ${active} active, ${stalled} stalled\x1b[0m\n`);
  }
}

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
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`\x1b[31m✗\x1b[0m ${user} (${id}): capture failed — ${msg}`);
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
