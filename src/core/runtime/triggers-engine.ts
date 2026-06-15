/**
 * Trigger Engine — core fire/match logic and shared state.
 *
 * Fires shell commands in response to events (issue-close, pr-merge, agent-idle, etc.).
 * Actions support template variables: {agent}, {repo}, {issue}, {event}.
 */

// No execSync — use async Bun.spawn to avoid blocking event loop
import { loadConfig, saveConfig, type TriggerConfig, type TriggerEvent } from "../../config";
import { logAudit } from "../fleet/audit";
import { isAgentExemptFromTrigger } from "./idle-exempt";

export interface TriggerContext {
  agent?: string;
  repo?: string;
  issue?: string;
  [key: string]: string | undefined;
}

export interface TriggerFireResult {
  trigger: TriggerConfig;
  action: string;
  ok: boolean;
  output?: string;
  error?: string;
  ts: number;
}

/** Last-fired timestamp per trigger (index in config array → result) */
const lastFired = new Map<number, TriggerFireResult>();

/** Idle tracking: agent → last feed activity timestamp (ms) */
export const idleTimers = new Map<string, number>();

/** Track busy→idle transition: only fire agent-idle when agent WAS busy (#149) */
export const agentPrevState = new Map<string, "busy" | "idle">();

/** Remove trigger state for agents absent from feed events for this long (#2386). */
export const STALE_AGENT_STATE_MS = 60 * 60 * 1000;

/**
 * Sweep idle/transition state for agents not seen in feed events recently.
 *
 * `idleTimers` is the source of truth for last feed activity. Keeping idle
 * agents there until this sweep lets `agentPrevState` be pruned by age too,
 * instead of accumulating idle entries indefinitely.
 */
export function sweepStaleAgentState(now = Date.now(), maxAgeMs = STALE_AGENT_STATE_MS): string[] {
  const removed: string[] = [];

  for (const [agent, lastSeen] of idleTimers) {
    if (now - lastSeen > maxAgeMs) {
      idleTimers.delete(agent);
      agentPrevState.delete(agent);
      removed.push(agent);
    }
  }

  // Defensive cleanup for any transition state left without a feed timestamp.
  for (const agent of agentPrevState.keys()) {
    if (!idleTimers.has(agent)) {
      agentPrevState.delete(agent);
      removed.push(agent);
    }
  }

  return removed;
}

/**
 * Expand template variables in an action string.
 * Supports {agent}, {repo}, {issue}, {event}, and any key in context.
 */
function expandAction(action: string, event: TriggerEvent, ctx: TriggerContext): string {
  let result = action;
  result = result.replace(/\{event\}/g, event);
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined) {
      // Use split/join — no dynamic RegExp, so no ReDoS surface from arbitrary ctx keys.
      result = result.split(`{${key}}`).join(value);
    }
  }
  return result;
}

/**
 * Get all configured triggers.
 */
export function getTriggers(): TriggerConfig[] {
  return loadConfig().triggers || [];
}

/**
 * Get trigger history (last-fired results).
 */
export function getTriggerHistory(): { index: number; result: TriggerFireResult }[] {
  return [...lastFired.entries()]
    .map(([index, result]) => ({ index, result }))
    .sort((a, b) => b.result.ts - a.result.ts);
}

/**
 * Fire all triggers matching an event type.
 * Filters by repo if the trigger has a repo constraint.
 * Returns array of results for each trigger fired.
 */
export async function fire(event: TriggerEvent, ctx: TriggerContext = {}): Promise<TriggerFireResult[]> {
  const triggers = getTriggers();
  const results: TriggerFireResult[] = [];

  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (t.on !== event) continue;

    // Repo filter: skip if trigger specifies repo and it doesn't match
    if (t.repo && ctx.repo && t.repo !== ctx.repo) continue;

    // Idle timeout check: skip if agent hasn't been idle long enough
    if (event === "agent-idle" && t.timeout && ctx.agent) {
      const lastActivity = idleTimers.get(ctx.agent);
      if (lastActivity) {
        const idleSec = (Date.now() - lastActivity) / 1000;
        if (idleSec < t.timeout) continue;
      }
    }

    // #2555 — channel-aware exemption: a trigger with exempt:["channel-listener"]
    // never fires for an agent subscribed to a channel plugin (idle-but-waiting).
    if (event === "agent-idle" && ctx.agent && isAgentExemptFromTrigger(t, ctx.agent)) {
      continue;
    }

    const action = expandAction(t.action, event, ctx);
    const result: TriggerFireResult = { trigger: t, action, ok: false, ts: Date.now() };

    try {
      const proc = Bun.spawn(["bash", "-c", action], { stdout: "pipe", stderr: "pipe", env: { ...process.env }, windowsHide: true });
      const output = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`exit ${code}`);
      result.ok = true;
      result.output = output;
    } catch (err: any) {
      result.error = err.message?.slice(0, 200) || "unknown error";
    }

    lastFired.set(i, result);
    results.push(result);

    // Audit log
    logAudit("trigger:fire", [event, t.action, result.ok ? "ok" : "error"], result.ok ? "ok" : result.error);

    // One-time triggers: remove after successful fire (#149)
    if (t.once && result.ok) {
      const config = loadConfig();
      const updated = (config.triggers || []).filter((_: TriggerConfig, idx: number) => idx !== i);
      saveConfig({ triggers: updated });
      console.log(`\x1b[33m[trigger]\x1b[0m one-time trigger fired and removed: ${t.name || t.action.slice(0, 40)}`);
    }
  }

  return results;
}
