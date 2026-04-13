import { Elysia } from "elysia";

export const deprecatedApi = new Elysia();

// Token + maw-log APIs removed — use POST /api/feed for all events
deprecatedApi.get("/tokens", ({ set }) => { set.status = 410; return { error: "removed — use /api/feed" }; });
deprecatedApi.get("/tokens/rate", () => ({ totalTokens: 0, totalPerMin: 0, inputPerMin: 0, outputPerMin: 0, inputTokens: 0, outputTokens: 0, turns: 0 }));
deprecatedApi.get("/maw-log", () => ({ entries: [], total: 0 }));
