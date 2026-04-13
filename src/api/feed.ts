import { Elysia, t } from "elysia";
import type { FeedEvent } from "../lib/feed";
import { markRealFeedEvent } from "../engine/status";
import { cfgLimit } from "../config";

export const feedBuffer: FeedEvent[] = [];
export const feedListeners = new Set<(event: FeedEvent) => void>();

export function pushFeedEvent(event: FeedEvent) {
  feedBuffer.push(event);
  const feedMax = cfgLimit("feedMax");
  if (feedBuffer.length > feedMax) feedBuffer.splice(0, feedBuffer.length - feedMax);
  for (const fn of feedListeners) fn(event);
}

export const feedApi = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients filtering `event === "MessageSend"`. See docs/federation.md.
feedApi.get("/feed", ({ query }) => {
  const limit = Math.min(200, +(query.limit || String(cfgLimit("feedDefault"))));
  const oracle = query.oracle || undefined;
  let events = feedBuffer.slice(-limit);
  if (oracle) events = events.filter(e => e.oracle === oracle);
  const activeMap = new Map<string, FeedEvent>();
  const cutoff = Date.now() - 5 * 60_000;
  for (const e of feedBuffer) { if (e.ts >= cutoff) activeMap.set(e.oracle, e); }
  return { events: events.reverse(), total: events.length, active_oracles: [...activeMap.keys()] };
}, {
  query: t.Object({
    limit: t.Optional(t.String()),
    oracle: t.Optional(t.String()),
  }),
});

feedApi.post("/feed", async ({ body }) => {
  const b = body as any;
  const event: FeedEvent = {
    timestamp: b.timestamp || new Date().toISOString(),
    oracle: b.oracle || "unknown",
    host: b.host || "local",
    event: b.event || "Notification",
    project: b.project || "",
    sessionId: b.sessionId || "",
    message: b.message || "",
    ts: b.ts || Date.now(),
  };
  pushFeedEvent(event);
  markRealFeedEvent(event.oracle);
  const wtMatch = event.project.match(/[.-]wt-(?:\d+-)?(.+)$/);
  if (wtMatch) markRealFeedEvent(`${event.oracle}-${wtMatch[1]}`);
  return { ok: true };
}, {
  body: t.Object({
    timestamp: t.Optional(t.String()),
    oracle: t.Optional(t.String()),
    host: t.Optional(t.String()),
    event: t.Optional(t.String()),
    project: t.Optional(t.String()),
    sessionId: t.Optional(t.String()),
    message: t.Optional(t.String()),
    ts: t.Optional(t.Number()),
  }),
});
