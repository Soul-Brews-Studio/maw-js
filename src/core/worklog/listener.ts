/**
 * Passive feed listener — persists significant tool-call events to the worklog.
 *
 * Wired once in src/core/server.ts next to the existing feed listeners. This is
 * NOT a background loop / interval — it only reacts to feed events that already
 * arrive (CC PostToolUse hooks → POST /api/feed → feedListeners). PR lifecycle
 * is handled separately by the on-demand poller, so this listener ignores it.
 */

import type { FeedEvent } from "../../lib/feed";
import { eventToWorklog } from "./significant";
import { appendWorklogAsync } from "./store";

let registered = false;

export function registerWorklogListener(
  feedListeners: Set<(event: FeedEvent) => void>,
): void {
  if (registered) return; // idempotent — survive serve-hook reloads
  registered = true;
  feedListeners.add((event) => {
    try {
      const entry = eventToWorklog(event);
      if (entry) appendWorklogAsync(entry); // non-blocking on the feed hot path
    } catch {
      /* never break the feed pipeline because of the worklog */
    }
  });
}

/** @internal — tests */
export function _resetWorklogListener(): void {
  registered = false;
}
