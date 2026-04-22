/**
 * Fleet-lens API — Claude Code session discovery (Phase 1).
 *
 * GET /fleet/claude  → list all discovered Claude Code sessions
 *
 * Localhost-only. Never exposed via federation HMAC peer channel.
 * Transcripts may contain sensitive content (credentials, secrets).
 */

import { Elysia } from "elysia";
import { listClaudeSessions } from "../core/fleet/claude-sessions";
import { listFleetJobs } from "../core/fleet/claude-jobs";

export const claudeFleetApi = new Elysia();

claudeFleetApi.get("/fleet/claude", async ({ set }) => {
  try {
    // Sessions are the main load; jobs (regression-then-investigate.sh,
    // future watcher daemons) are a best-effort augmentation. Wrap the
    // jobs lookup in a catch so a transient pgrep / fs hiccup never
    // breaks the primary fleet-lens response.
    const [sessions, jobs] = await Promise.all([
      listClaudeSessions(),
      listFleetJobs().catch(() => []),
    ]);
    return { sessions, jobs, count: sessions.length };
  } catch (e: any) {
    set.status = 500;
    return { error: "Failed to discover Claude sessions", detail: e.message };
  }
}, {
  detail: {
    summary: "List Claude Code sessions + fleet jobs",
    description: "Discovers running and recent Claude Code sessions on this node via ~/.claude/projects/ scan + process correlation. Also surfaces background fleet jobs (regression runners) detected via pgrep.",
    tags: ["fleet-lens"],
  },
});
