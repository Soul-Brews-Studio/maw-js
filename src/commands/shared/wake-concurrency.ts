/**
 * wake-concurrency.ts — agent concurrency cap for `maw wake` (#2).
 *
 * `cmdWake` had no count, queue, or cap: nothing stopped a script (or a
 * runaway orchestrator) from spawning agents until the box fell over.
 * `D.limits` governed feed/logs/pty/message sizes but nothing about agent
 * count.
 *
 * This module adds an opt-in cap. When `limits.maxConcurrentAgents` is a
 * positive number, `maw wake` counts the agent panes already live across the
 * fleet and refuses ("fails loud") to spawn one more once the fleet is at or
 * over the cap. `0` / unset disables the cap — no behavior change for anyone
 * who has not configured it.
 *
 * Pure decision logic (`checkCapacity`) is split from the tmux I/O
 * (`countLiveAgents`) so the over-cap path is unit-testable without a tmux
 * server.
 */

import { cfgLimit } from "../../config";
import { tmux } from "../../core/transport/tmux";
import { isAgentCommand } from "../../core/transport/ssh";

/**
 * Pure cap decision — throws a loud, actionable error when `liveAgents` is at
 * or over `cap`. A `cap` of `0` or less means "disabled" and is always a
 * no-op. Kept free of I/O so tests can exercise every branch directly.
 */
export function checkCapacity(liveAgents: number, cap: number, spawning: string): void {
  if (!cap || cap <= 0) return; // cap disabled — opt-in only
  if (liveAgents >= cap) {
    throw new Error(
      `agent concurrency cap reached: ${liveAgents}/${cap} agents already live — ` +
      `refusing to spawn '${spawning}'. Raise limits.maxConcurrentAgents in maw.config.json ` +
      `or sleep an idle agent first (maw sleep <agent>).`,
    );
  }
}

/** Count tmux panes currently running an agent process across all sessions. */
export async function countLiveAgents(): Promise<number> {
  const panes = await tmux.listPanes();
  return panes.filter(p => isAgentCommand(p.command)).length;
}

/**
 * Guard a spawn against the configured agent concurrency cap (#2). No-op when
 * `limits.maxConcurrentAgents` is `0` / unset — and in that case we skip the
 * tmux `list-panes` call entirely so the disabled path stays free.
 *
 * @param spawning  the oracle/agent name about to be spawned — surfaced in the
 *                  error so the operator knows what was refused.
 */
export async function assertAgentCapacity(spawning: string): Promise<void> {
  const cap = cfgLimit("maxConcurrentAgents");
  if (!cap || cap <= 0) return; // disabled — don't even query tmux
  checkCapacity(await countLiveAgents(), cap, spawning);
}
