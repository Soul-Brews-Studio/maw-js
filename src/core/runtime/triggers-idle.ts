/**
 * Idle tracking for the trigger engine.
 *
 * Tracks agent activity timestamps and fires "agent-idle" triggers when
 * an agent transitions from busy→idle and the configured timeout elapses.
 */

import type { TriggerConfig } from "../../config";
import { fire, getTriggers, idleTimers, agentPrevState } from "./triggers-engine";

/**
 * Update idle tracking for an agent.
 * Call this on every agent activity to reset the idle timer.
 */
export function markAgentActive(agent: string): void {
  idleTimers.set(agent, Date.now());
  agentPrevState.set(agent, "busy"); // Track transition for busy→idle detection (#149)
}

/**
 * Check all agents for idle timeout and fire triggers.
 * Returns agents that triggered.
 */
export async function checkIdleTriggers(): Promise<string[]> {
  const triggers: TriggerConfig[] = getTriggers().filter((t: TriggerConfig) => t.on === "agent-idle");
  if (!triggers.length) return [];

  const fired: string[] = [];
  for (const [agent, lastActive] of idleTimers) {
    // Only fire if agent transitioned from busy→idle (#149)
    const prevState = agentPrevState.get(agent);
    if (prevState !== "busy") continue;

    const idleSec = (Date.now() - lastActive) / 1000;
    for (const t of triggers) {
      if (t.timeout && idleSec >= t.timeout) {
        const results = await fire("agent-idle", { agent });
        if (results.some((r) => r.ok)) {
          fired.push(agent);
          agentPrevState.set(agent, "idle");
        }
      }
    }
  }
  return fired;
}
