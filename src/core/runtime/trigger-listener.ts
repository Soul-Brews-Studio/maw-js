/**
 * Trigger Listener — Hooks feed events into the TriggerEngine.
 *
 * Maps FeedEvent types to TriggerEvent types and fires matching triggers.
 * Also runs periodic idle-timeout checks.
 */

import type { FeedEvent } from "../../lib/feed";
import { fire, markAgentActive, checkIdleTriggers, getTriggers, sweepStaleAgentState } from "./triggers";
import { agentStatusStore } from "../agent-status";

function unrefInterval(timer: ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Register a feed listener that maps feed events → trigger events.
 * Also starts periodic idle checks if any agent-idle triggers exist.
 */
export function setupTriggerListener(feedListeners: Set<(event: FeedEvent) => void>): void {
  feedListeners.add((event: FeedEvent) => {
    // Any activity from an agent resets its idle timer
    if (event.oracle) {
      markAgentActive(event.oracle);
    }

    // Map feed events to trigger events
    switch (event.event) {
      case "SessionStart":
        fire("agent-wake", { agent: event.oracle });
        agentStatusStore.report(event.oracle, "busy", {
          sessionId: event.sessionId,
          project: event.project,
          event: "SessionStart",
        });
        break;

      // Agent crash detection (message contains "crashed" or similar)
      case "Notification":
        if (event.message.toLowerCase().includes("crash")) {
          fire("agent-crash", { agent: event.oracle });
        }
        break;
    }
  });

  // Periodic stale-state sweep: prune agents absent from feed events for >1h (#2386).
  unrefInterval(setInterval(() => {
    sweepStaleAgentState();
  }, 15 * 60 * 1000));

  // Periodic idle check (every 15s)
  const idleTriggers = getTriggers().filter(t => t.on === "agent-idle");
  if (idleTriggers.length > 0) {
    unrefInterval(setInterval(() => {
      checkIdleTriggers();
    }, 15_000));
  }
}
