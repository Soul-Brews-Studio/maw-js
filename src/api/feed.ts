import { Hono } from "hono";
import type { FeedEvent } from "../lib/feed";
import { markRealFeedEvent } from "../engine/status";

export const feedBuffer: FeedEvent[] = [];
export const FEED_MAX = 500;
export const feedListeners = new Set<(event: FeedEvent) => void>();

export function pushFeedEvent(event: FeedEvent) {
  feedBuffer.push(event);
  if (feedBuffer.length > FEED_MAX) feedBuffer.splice(0, feedBuffer.length - FEED_MAX);
  for (const fn of feedListeners) fn(event);
}

export const feedApi = new Hono();

feedApi.get("/feed", (c) => {
  const limit = Math.min(200, +(c.req.query("limit") || "50"));
  const oracle = c.req.query("oracle") || undefined;
  let events = feedBuffer.slice(-limit);
  if (oracle) events = events.filter(e => e.oracle === oracle);
  const activeMap = new Map<string, FeedEvent>();
  const cutoff = Date.now() - 5 * 60_000;
  for (const e of feedBuffer) { if (e.ts >= cutoff) activeMap.set(e.oracle, e); }
  return c.json({ events: events.reverse(), total: events.length, active_oracles: [...activeMap.keys()] });
});

feedApi.post("/feed", async (c) => {
  const body = await c.req.json();
  const event: FeedEvent = {
    timestamp: body.timestamp || new Date().toISOString(),
    oracle: body.oracle || "unknown",
    host: body.host || "local",
    event: body.event || "Notification",
    project: body.project || "",
    sessionId: body.sessionId || "",
    message: body.message || "",
    ts: body.ts || Date.now(),
  };
  pushFeedEvent(event);
  markRealFeedEvent(event.oracle);
  return c.json({ ok: true });
});
