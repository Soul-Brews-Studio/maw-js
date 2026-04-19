/**
 * fleet-wake-failsoft.ts — pure helpers for `maw wake all`'s fail-soft loop.
 *
 * Extracted so unit tests can import these without dragging in the full
 * cmdWakeAll chain (tmux transport, wake-session, sdk, etc.) and without
 * colliding with sibling test files that mock `../../sdk` narrowly.
 *
 * See: fleet-wake.ts (consumer) and test/fleet-wake-ssh-failsoft.test.ts.
 */
import { HostExecError } from "../../core/transport/ssh";

/** First line of an unreachable-host error, for compact display. */
export function firstStderrLine(e: unknown): string {
  if (e instanceof HostExecError) {
    return e.underlying.message.split("\n")[0].trim() || `exit ${e.exitCode ?? "?"}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0].trim();
}

/** True when a hostExec failure is an ssh transport failure (DNS / refused / timeout / non-zero). */
export function isSshTransportError(e: unknown): boolean {
  return e instanceof HostExecError && e.transport === "ssh";
}

export interface WakeStep {
  sessName: string;
  /** Simulates the per-session tmux work. Throws to signal failure. */
  run: () => Promise<void>;
}

export interface WakeLoopResult {
  sessCount: number;
  remoteSkipped: number;
  warnings: string[];
}

/**
 * Fail-soft session-wake loop.
 *
 * Given an ordered list of wake steps, invoke each. On HostExecError with
 * transport === "ssh", capture a compact warning string and skip the session
 * without aborting the loop. Non-ssh errors propagate (don't silently swallow
 * bugs). Returns counters the caller uses for the summary line.
 */
export async function runWakeLoopFailSoft(steps: WakeStep[]): Promise<WakeLoopResult> {
  let sessCount = 0;
  let remoteSkipped = 0;
  const warnings: string[] = [];

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const progress = `[${si + 1}/${steps.length}]`;
    try {
      await step.run();
      sessCount++;
    } catch (e) {
      if (isSshTransportError(e)) {
        const err = e as HostExecError;
        warnings.push(
          `${progress} ${step.sessName} — [ssh:${err.target}] unreachable: ${firstStderrLine(err)}`
        );
        remoteSkipped++;
        continue;
      }
      throw e;
    }
  }

  return { sessCount, remoteSkipped, warnings };
}
