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

import * as config from "../../config";
import { tmux } from "../../core/transport/tmux";
import { isAgentCommand } from "../../core/transport/ssh";
import { UserError } from "../../core/util/user-error";
import { channelListenerIds } from "./channel-loader";

/**
 * Pure cap decision — throws a loud, actionable error when `liveAgents` is at
 * or over `cap`. A `cap` of `0` or less means "disabled" and is always a
 * no-op. Kept free of I/O so tests can exercise every branch directly.
 */
const MAX_CONCURRENT_AGENTS_KEY = "limits.maxConcurrentAgents";

export function maxConcurrentAgentsSourceLine(): string {
  try {
    const loaded = config.loadConfigWithProvenance?.({ cwd: process.cwd() });
    const entries = loaded?.provenance?.[MAX_CONCURRENT_AGENTS_KEY] ?? [];
    const source = [...entries].reverse().find((entry) => entry.action === "set");
    const value = config.cfgLimit("maxConcurrentAgents");
    if (source) {
      return `${MAX_CONCURRENT_AGENTS_KEY}: ${value} from ${source.path}`;
    }
    return `${MAX_CONCURRENT_AGENTS_KEY}: ${value} from built-in default`;
  } catch {
    const value = config.cfgLimit("maxConcurrentAgents");
    return `${MAX_CONCURRENT_AGENTS_KEY}: ${value} (config source unavailable)`;
  }
}

export function checkCapacity(
  liveAgents: number,
  cap: number,
  spawning: string,
  sourceLine = `${MAX_CONCURRENT_AGENTS_KEY}: ${cap}`,
): void {
  if (!cap || cap <= 0) return; // cap disabled by explicit opt-out
  if (liveAgents >= cap) {
    throw new UserError(
      `agent concurrency cap reached: ${liveAgents}/${cap} agents already live — ` +
      `refusing to spawn '${spawning}'.\n\n` +
      `Config: ${sourceLine}\n\n` +
      `Fix: Raise limits.maxConcurrentAgents in your maw config ` +
      `or sleep an idle agent first (maw sleep <agent>).`,
    );
  }
}

export interface LiveAgent {
  name: string;
  target: string;
  idleSec: number;
  /** #2555 — channel plugin ids the agent listens on ([] = not a listener). */
  channel: string[];
}

/**
 * #2555 — channel plugin ids for a live agent pane. The repo dir in the pane
 * cwd (`…/discord-oracle/agents/…`) is the authoritative stem; the pane title /
 * window name is the fallback for non-worktree panes.
 */
function paneChannelIds(p: { cwd?: string; title?: string; winName?: string; target: string }): string[] {
  const fromCwd = p.cwd?.match(/([^/]+)-oracle(?:\/|$)/)?.[1];
  return channelListenerIds(fromCwd || p.title || p.winName || p.target);
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
      channel: paneChannelIds(p),
    }));
}

/** Count tmux panes currently running an agent process across all sessions. */
export async function countLiveAgents(): Promise<number> {
  return (await listLiveAgents()).length;
}

export function formatAgentTable(agents: LiveAgent[]): string {
  const sorted = [...agents].sort((a, b) => b.idleSec - a.idleSec);
  const lines = sorted.map(a => {
    const idle = a.idleSec > 60
      ? `${Math.round(a.idleSec / 60)}m`
      : `${a.idleSec}s`;
    // #2555 — flag channel listeners so the operator doesn't sleep an
    // idle-but-waiting relay to free a slot (it's auto-sleep exempt).
    const channel = a.channel?.length ? `  \x1b[36m📡 [ch: ${a.channel.join(", ")}]\x1b[0m` : "";
    return `  ${a.name.padEnd(40)} idle ${idle.padStart(5)}   ${a.target}${channel}`;
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
  const cap = config.cfgLimit("maxConcurrentAgents");
  if (!cap || cap <= 0) return;
  const agents = await listLiveAgents();
  if (agents.length >= cap) {
    const sourceLine = maxConcurrentAgentsSourceLine();
    const table = formatAgentTable(agents);
    throw new UserError(
      `agent concurrency cap reached: ${agents.length}/${cap} agents already live — ` +
      `refusing to spawn '${spawning}'.\n\n` +
      `Active agents:\n${table}\n\n` +
      `Config: ${sourceLine}\n\n` +
      `Fix: maw sleep <name>  — free a slot by sleeping an idle agent\n` +
      `     Set limits.maxConcurrentAgents in your maw config to raise the cap`,
    );
  }
}
