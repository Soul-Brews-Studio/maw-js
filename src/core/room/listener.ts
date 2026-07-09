/**
 * Room feed listener (kobo-241, slice 2) — persists a room's turns to its off-card
 * artifact off the SAME feed events the slice-1 wire already emits.
 *
 * Every hey emits a MessageSend/MessageDeliver feed event (buildMessageLifecycleFeedEvent).
 * The slice-1 room wire tags both directions `[room:<id>]`, so this passive listener
 * (registered next to registerWorklogListener in the serve hook) appends each tagged
 * turn to `rooms/<id>.json`. NOT a loop/interval — it only reacts to feed events that
 * already arrive. Idempotent per source message id (a hey can emit several lifecycle
 * events). Reuses feedListeners + the room store — no new transport/capture.
 */

import type { FeedEvent } from "../../lib/feed";
import { appendRoomMessage, findRoomCompany } from "./store";

let registered = false;

/** Extract the room id from a `[room:<id>]` tag in the text (null if none). */
export function parseRoomId(text: string | undefined): string | null {
  const m = /\[room:([^\]\s]+)\]/.exec(text ?? "");
  return m ? m[1] : null;
}

/** Strip the `[room:<id>]` tag so the stored/rendered text is clean. */
export function stripRoomTag(text: string | undefined): string {
  return (text ?? "").replace(/\[room:[^\]\s]+\]\s?/g, "").trim();
}

/**
 * On a room-tagged message feed event, append the turn to its artifact. Returns true
 * when it persisted (used by tests); false when the event isn't a room message or no
 * matching room is open. Exposed so a test can drive it without the feedListeners Set.
 */
export function onRoomFeedEvent(event: FeedEvent): boolean {
  if (event.event !== "MessageSend" && event.event !== "MessageDeliver") return false;
  const data = (event as { data?: { text?: string; from?: string; id?: string } }).data;
  const roomId = parseRoomId(data?.text);
  if (!roomId) return false;
  const company = findRoomCompany(roomId); // only OPENED rooms have an artifact
  if (!company) return false;
  const res = appendRoomMessage(company, roomId, {
    id: data?.id || `${event.oracle}-${event.ts}`,
    from: data?.from || event.oracle || "?",
    text: stripRoomTag(data?.text),
    ts: event.ts || Date.now(),
  });
  return !!res;
}

export function registerRoomListener(feedListeners: Set<(event: FeedEvent) => void>): void {
  if (registered) return; // idempotent — survive serve-hook reloads
  registered = true;
  feedListeners.add((event) => {
    try { onRoomFeedEvent(event); }
    catch { /* never break the feed pipeline because of a room write */ }
  });
}

/** @internal — tests */
export function _resetRoomListener(): void {
  registered = false;
}
