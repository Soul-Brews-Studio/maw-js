/**
 * Claude Code fleet-lens API.
 *
 * GET /api/fleet/claude                       → list live/recent sessions
 * GET /api/fleet/claude/:sessionId/transcript → paginated JSONL messages
 *
 * Backs the upcoming oracle-studio "office scene" page. Localhost-only by
 * convention — transcripts can contain pasted credentials; never expose this
 * through the federation HMAC /api/peer/exec channel.
 */
import { Elysia, t } from "elysia";
import { listClaudeSessions, invalidateCache } from "../core/fleet/claude-sessions";
import { readTranscript } from "../core/fleet/claude-transcript";

export const claudeFleetApi = new Elysia();

claudeFleetApi.get("/fleet/claude", async ({ query, set }) => {
  try {
    if (query.nocache === "true") invalidateCache();
    const sessions = await listClaudeSessions();
    return { sessions, total: sessions.length, generatedAt: new Date().toISOString() };
  } catch (e: any) {
    set.status = 500;
    return { error: String(e?.message || e) };
  }
}, {
  query: t.Object({
    nocache: t.Optional(t.String()),
  }),
});

claudeFleetApi.get("/fleet/claude/:sessionId/transcript", async ({ params, query, set }) => {
  const sessionId = params.sessionId;
  if (!/^[a-f0-9-]{8,}$/.test(sessionId)) {
    set.status = 400;
    return { error: "invalid sessionId" };
  }
  const sessions = await listClaudeSessions();
  const match = sessions.find(s => s.sessionId === sessionId);
  if (!match) {
    set.status = 404;
    return { error: "session not found", sessionId };
  }
  try {
    const tail = Math.min(+(query.tail || "50"), 500);
    const entries = await readTranscript(match.jsonlPath, {
      tail,
      raw: query.raw === "true",
    });
    return {
      sessionId,
      jsonlPath: match.jsonlPath,
      status: match.status,
      total: entries.length,
      entries,
    };
  } catch (e: any) {
    set.status = 500;
    return { error: String(e?.message || e), sessionId };
  }
}, {
  params: t.Object({ sessionId: t.String() }),
  query: t.Object({
    tail: t.Optional(t.String()),
    raw: t.Optional(t.String()),
    since: t.Optional(t.String()),
  }),
});
