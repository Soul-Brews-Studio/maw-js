/**
 * wake-concurrency.ts — agent concurrency cap for `maw wake` (#2).
 *
 * `cmdWake` had no count, queue, or cap: nothing stopped a script (or a
 * runaway orchestrator) from spawning agents until the box fell over.
 * `D.limits` governed feed/logs/pty/message sizes but nothing about agent
 * count.
 *
 * This module adds a default cap. When `limits.maxConcurrentAgents` is a
 * positive number, `maw wake` counts the agent panes already live across the
 * fleet and refuses ("fails loud") to spawn one more once the fleet is at or
 * over the cap. Explicit `0` disables the cap for operators that intentionally
 * want unbounded spawning.
 *
 * Pure decision logic (`checkCapacity`) is split from the tmux I/O
 * (`countLiveAgents`) so the over-cap path is unit-testable without a tmux
 * server.
 */

import { cfgLimit } from "../../config";
import { tmux } from "../../core/transport/tmux";
import { isAgentCommand } from "../../core/transport/ssh";
import { UserError } from "../../core/util/user-error";

/**
 * Pure cap decision — throws a loud, actionable error when `liveAgents` is at
 * or over `cap`. A `cap` of `0` or less means "disabled" and is always a
 * no-op. Kept free of I/O so tests can exercise every branch directly.
 */
export function checkCapacity(liveAgents: number, cap: number, spawning: string): void {
  if (!cap || cap <= 0) return; // cap disabled by explicit opt-out
  if (liveAgents >= cap) {
    throw new UserError(
      `agent concurrency cap reached: ${liveAgents}/${cap} agents already live — ` +
      `refusing to spawn '${spawning}'. Raise limits.maxConcurrentAgents in maw.config.json ` +
      `or sleep an idle agent first (maw sleep <agent>).`,
    );
  }
}

export interface LiveAgent {
  name: string;
  target: string;
  idleSec: number;
}

/** List tmux panes currently running an agent process with metadata. */
export async function listLiveAgents(): Promise<LiveAgent[]> {
  const panes = await tmux.listPanes();
  const now = Date.now() / 1000;
  return panes
    .filter(p => isAgentCommand(p.command))
    .map(p => ({
      name: p.title || p.winName || p.target,
      target: p.target,
      idleSec: p.lastActivity ? Math.round(now - p.lastActivity) : 0,
    }));
}

/** Count tmux panes currently running an agent process across all sessions. */
export async function countLiveAgents(): Promise<number> {
  return (await listLiveAgents()).length;
}

function formatAgentTable(agents: LiveAgent[]): string {
  const sorted = [...agents].sort((a, b) => b.idleSec - a.idleSec);
  const lines = sorted.map(a => {
    const idle = a.idleSec > 60
      ? `${Math.round(a.idleSec / 60)}m`
      : `${a.idleSec}s`;
    return `  ${a.name.padEnd(40)} idle ${idle.padStart(5)}   ${a.target}`;
  });
  return lines.join("\n");
}

/**
 * Guard a spawn against the configured agent concurrency cap (#2). No-op when
 * `limits.maxConcurrentAgents` is explicitly `0` — and in that case we skip
 * the tmux `list-panes` call entirely so the disabled path stays free.
 *
 * @param spawning  the oracle/agent name about to be spawned — surfaced in the
 *                  error so the operator knows what was refused.
 */
export async function assertAgentCapacity(spawning: string): Promise<void> {
  const cap = cfgLimit("maxConcurrentAgents");
  if (!cap || cap <= 0) return;
  const agents = await listLiveAgents();
  if (agents.length >= cap) {
    const table = formatAgentTable(agents);
    throw new UserError(
      `agent concurrency cap reached: ${agents.length}/${cap} agents already live — ` +
      `refusing to spawn '${spawning}'.\n\n` +
      `Active agents:\n${table}\n\n` +
      `Fix: maw sleep <name>  — free a slot by sleeping an idle agent\n` +
      `     Set limits.maxConcurrentAgents in maw.config.json to raise the cap`,
    );
  }
}
