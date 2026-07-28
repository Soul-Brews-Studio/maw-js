/**
 * kobo-458 — pure decision logic, deliberately separated from any pm2/process
 * side effect: this only decides WHETHER to restart from a probe history, and
 * says WHY, so a caller can log the decision before ever touching pm2.
 *
 * Restart triggers on N *consecutive* `dead` results only — one blip must not
 * restart (the card's own evidence: one incident recovered on its own after
 * ~1 minute with no intervention). `slow` and `probe-error` both BREAK the
 * dead streak and never themselves count toward it:
 *   - `slow` is a real answer (kobo-453's territory — a hung/slow call must
 *     never be conflated with a refused one).
 *   - `probe-error` means the WATCHER couldn't even attempt the check — it
 *     must never be misread as either "the server confirmed dead" (would
 *     restart a server nobody actually asked) or "everything's fine" (would
 *     hide the watcher's own failure by absence, kobo-446's family).
 */

import type { ProbeResult } from "./probe";

export interface RestartDecision {
  restart: boolean;
  reason: string;
}

export interface RestartDecisionOpts {
  consecutiveDeadThreshold?: number;
}

const DEFAULT_CONSECUTIVE_DEAD_THRESHOLD = 3;

function trailingRunLength(history: ProbeResult[], status: ProbeResult["status"]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status !== status) break;
    n++;
  }
  return n;
}

export function shouldRestart(history: ProbeResult[], opts: RestartDecisionOpts = {}): RestartDecision {
  // %5 review at ccac44d: an unguarded threshold of 0 (or negative) makes
  // `consecutiveDead >= threshold` true unconditionally — an all-healthy
  // history would restart a server with zero evidence it was ever down.
  // Clamped, not thrown: this is a pure decision function a caller might
  // build `opts` for dynamically, and a bad config value should degrade to
  // the safest usable threshold (1 — a single dead result still restarts,
  // never zero evidence).
  const rawThreshold = opts.consecutiveDeadThreshold ?? DEFAULT_CONSECUTIVE_DEAD_THRESHOLD;
  const threshold = rawThreshold < 1 ? 1 : rawThreshold;

  // F3 (front review): a dead WATCHER (one that never runs a probe at all)
  // produces the exact same empty history as a genuinely fresh one — the two
  // are indistinguishable from history alone, so this must never read as
  // "healthy" in a log a human checks during the incident it can't detect.
  if (history.length === 0) {
    return { restart: false, reason: "no observations yet — a watcher that never ran would look identical, do not read this as confirmed healthy" };
  }

  const consecutiveDead = trailingRunLength(history, "dead");
  if (consecutiveDead >= threshold) {
    return { restart: true, reason: `${consecutiveDead} consecutive dead probes (threshold ${threshold})` };
  }

  // A trailing run of probe-error must be surfaced distinctly — it says
  // "the check is failing", not "the server is healthy" and not "the server
  // is dead." Checked AFTER the dead-streak (a genuine dead-streak is the
  // stronger, actionable signal) but BEFORE falling through to "healthy",
  // since the most recent evidence here is neither ok nor slow.
  const consecutiveProbeErrors = trailingRunLength(history, "probe-error");
  if (consecutiveProbeErrors > 0) {
    return {
      restart: false,
      reason: `WATCHER ERROR: ${consecutiveProbeErrors} consecutive probe-error result(s) — the check itself is failing, this does not confirm server health`,
    };
  }

  if (consecutiveDead > 0) {
    return { restart: false, reason: `${consecutiveDead} consecutive dead probe(s), below threshold ${threshold}` };
  }

  return { restart: false, reason: "healthy" };
}
