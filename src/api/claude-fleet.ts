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

export interface ClaudeFleetApiDeps {
  listClaudeSessions: typeof listClaudeSessions;
}

export function createClaudeFleetApi(deps: ClaudeFleetApiDeps = {
  listClaudeSessions,
}) {
  return new Elysia().get("/fleet/claude", async ({ set }) => {
    try {
      const sessions = await deps.listClaudeSessions();
      return { sessions, count: sessions.length };
    } catch (e: any) {
      set.status = 500;
      return { error: "Failed to discover Claude sessions", detail: e.message };
    }
  }, {
    detail: {
      summary: "List Claude Code sessions",
      description: "Discovers running and recent Claude Code sessions on this node via ~/.claude/projects/ scan + process correlation.",
      tags: ["fleet-lens"],
    },
  });
}

export const claudeFleetApi = createClaudeFleetApi();
