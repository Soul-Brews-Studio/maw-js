import { Elysia, t } from "elysia";
import type { FeedEvent } from "../lib/feed";
import { markRealFeedEvent } from "../engine/status";
import { cfgLimit } from "../config";

export const feedBuffer: FeedEvent[] = [];
export const feedListeners = new Set<(event: FeedEvent) => void>();

export interface FeedApiDeps {
  feedBuffer: FeedEvent[];
  feedListeners: Set<(event: FeedEvent) => void>;
  cfgLimit: typeof cfgLimit;
  markRealFeedEvent: typeof markRealFeedEvent;
  now: () => number;
  isoNow: () => string;
}

export const defaultFeedApiDeps: FeedApiDeps = {
  feedBuffer,
  feedListeners,
  cfgLimit,
  markRealFeedEvent,
  now: Date.now,
  isoNow: () => new Date().toISOString(),
};

export function pushFeedEventWithDeps(event: FeedEvent, deps: FeedApiDeps = defaultFeedApiDeps) {
  deps.feedBuffer.push(event);
  const feedMax = deps.cfgLimit("feedMax");
  if (deps.feedBuffer.length > feedMax) deps.feedBuffer.splice(0, deps.feedBuffer.length - feedMax);
  for (const fn of deps.feedListeners) fn(event);
}

export function pushFeedEvent(event: FeedEvent) {
  pushFeedEventWithDeps(event);
}

export function createFeedApi(deps: FeedApiDeps = defaultFeedApiDeps) {
  const api = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients filtering `event === "MessageSend"`. See docs/federation.md.
  api.get("/feed", ({ query }) => {
    const limit = Math.min(200, +(query.limit || String(deps.cfgLimit("feedDefault"))));
    const oracle = query.oracle || undefined;
    let events = deps.feedBuffer.slice(-limit);
    if (oracle) events = events.filter(e => e.oracle === oracle);
    const activeMap = new Map<string, FeedEvent>();
    const cutoff = deps.now() - 5 * 60_000;
    for (const e of deps.feedBuffer) { if (e.ts >= cutoff) activeMap.set(e.oracle, e); }
    return { events: events.reverse(), total: events.length, active_oracles: [...activeMap.keys()] };
  }, {
    query: t.Object({
      limit: t.Optional(t.String()),
      oracle: t.Optional(t.String()),
    }),
  });

  api.post("/feed", async ({ body }) => {
    const b = body as any;
    const event: FeedEvent = {
      timestamp: b.timestamp || deps.isoNow(),
      oracle: b.oracle || "unknown",
      host: b.host || "local",
      event: b.event || "Notification",
      project: b.project || "",
      sessionId: b.sessionId || "",
      message: b.message || "",
      ts: b.ts || deps.now(),
      ...(b.data !== undefined ? { data: b.data } : {}),
    };
    pushFeedEventWithDeps(event, deps);
    deps.markRealFeedEvent(event.oracle);
    const wtMatch = event.project.match(/[.-]wt-(?:\d+-)?(.+)$/);
    if (wtMatch) deps.markRealFeedEvent(`${event.oracle}-${wtMatch[1]}`);
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
      data: t.Optional(t.Unknown()),
    }),
  });

  return api;
}

export const feedApi = createFeedApi();
