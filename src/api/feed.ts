import { Hono } from "hono";
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

export const feedApi = new Hono();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients filtering `event === "MessageSend"`. See docs/federation.md.
feedApi.get("/feed", (c) => {
  const limit = Math.min(200, +(c.req.query("limit") || String(cfgLimit("feedDefault"))));
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
  // Mark oracle name + derived window name so StatusDetector can find the match.
  // Real feed: oracle="neo", project="neo-oracle.wt-3-maw-js" → window="neo-maw-js"
  markRealFeedEvent(event.oracle);
  const wtMatch = event.project.match(/[.-]wt-(?:\d+-)?(.+)$/);
  if (wtMatch) markRealFeedEvent(`${event.oracle}-${wtMatch[1]}`);
  return c.json({ ok: true });
});
