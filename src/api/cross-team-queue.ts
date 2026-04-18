// cross-team-queue.ts — GET /api/cross-team-queue
// Author: FORGE Oracle — 2026-04-18 (ADR-002 Day 2 — real scan)
//
// Replaces Day 1 scaffold with filesystem scan + query filters. Addresses
// NEXUS peer-review gotchas G1-G4 + adversarial A1:
//   G1 — Number() coercion guarded with Number.isFinite()
//   G2 — actionRequired enum validated, unknown → default "yes"
//   G3 — relPath semantics documented in types file + scan module
//   G4 — ageHours = max(date-parsed, mtime) in scan module
//   A1 — recipient list split on comma ONLY, reject `;`/quotes/other

import { Elysia } from "elysia";
import type {
  CrossTeamQueueItem,
  CrossTeamQueueResponse,
  CrossTeamQueueStats,
} from "../shared/cross-team-queue.types";
import { TEAM_ROSTER } from "../shared/cross-team-queue.types";
import { scanCrossTeamQueue } from "./cross-team-queue-scan";

// ─── Query guards ────────────────────────────────────────────────────────

function sanitizeList(raw: string | undefined): string[] {
  if (!raw) return [];
  // A1: reject suspicious chars — only allow letters, digits, dash, underscore, comma
  if (/[^A-Za-z0-9,_-]/.test(raw)) return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function coerceFinite(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined; // G1
}

function coerceActionRequired(raw: string | undefined): "yes" | "no" | "all" {
  if (raw === "no" || raw === "all") return raw;
  return "yes"; // G2: default + any unknown → safe default
}

// ─── Filtering ──────────────────────────────────────────────────────────

interface NormalizedQuery {
  teams: string[];
  recipients: string[];
  types: string[];
  actionRequired: "yes" | "no" | "all";
  maxAgeHours: number | undefined;
  limit: number | undefined;
}

function normalizeQuery(q: Record<string, string | undefined>): NormalizedQuery {
  const validTeams = new Set<string>([...Object.keys(TEAM_ROSTER), "unknown"]);
  return {
    teams: sanitizeList(q.team).filter((t) => validTeams.has(t)),
    recipients: sanitizeList(q.recipient),
    types: sanitizeList(q.type),
    actionRequired: coerceActionRequired(q.actionRequired),
    maxAgeHours: coerceFinite(q.maxAgeHours),
    limit: coerceFinite(q.limit),
  };
}

function passesFilter(item: CrossTeamQueueItem, q: NormalizedQuery): boolean {
  if (q.actionRequired === "yes" && !item.actionRequired) return false;
  if (q.actionRequired === "no" && item.actionRequired) return false;
  if (q.teams.length > 0 && !q.teams.includes(item.team)) return false;
  if (q.recipients.length > 0 && !q.recipients.includes(item.to)) return false;
  if (q.types.length > 0 && !q.types.includes(item.type.toLowerCase())) return false;
  if (q.maxAgeHours !== undefined && item.ageHours > q.maxAgeHours) return false;
  return true;
}

// ─── Aggregation ────────────────────────────────────────────────────────

function computeStats(items: CrossTeamQueueItem[]): CrossTeamQueueStats {
  const byTeam: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byRecipient: Record<string, number> = {};
  let oldestAgeHours = 0;
  for (const it of items) {
    byTeam[it.team] = (byTeam[it.team] ?? 0) + 1;
    byType[it.type] = (byType[it.type] ?? 0) + 1;
    byRecipient[it.to] = (byRecipient[it.to] ?? 0) + 1;
    if (it.ageHours > oldestAgeHours) oldestAgeHours = it.ageHours;
  }
  return { byTeam, byType, byRecipient, oldestAgeHours };
}

function groupByRecipient(
  items: CrossTeamQueueItem[],
  limit: number | undefined
): Record<string, CrossTeamQueueItem[]> {
  const out: Record<string, CrossTeamQueueItem[]> = {};
  for (const it of items) {
    (out[it.to] ??= []).push(it);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => b.ageHours - a.ageHours);
    if (limit !== undefined) out[key] = out[key].slice(0, limit);
  }
  return out;
}

// ─── Handler ────────────────────────────────────────────────────────────

export const crossTeamQueueApi = new Elysia();

crossTeamQueueApi.get("/cross-team-queue", ({ query }) => {
  const q = normalizeQuery((query ?? {}) as Record<string, string | undefined>);

  const scan = scanCrossTeamQueue();
  const filtered = scan.items.filter((it) => passesFilter(it, q));

  // Sort flat items by age (oldest first — most likely overdue)
  filtered.sort((a, b) => b.ageHours - a.ageHours);

  const response: CrossTeamQueueResponse = {
    schemaVersion: 1,
    scannedAt: new Date(scan.scannedAt).toISOString(),
    scannedFileCount: scan.scannedFileCount,
    parseErrorCount: scan.errors.length,
    total: filtered.length,
    items: filtered,
    byRecipient: groupByRecipient(filtered, q.limit),
    stats: computeStats(filtered),
    emptyInboxes: scan.emptyInboxes,
    errors: scan.errors,
  };

  return response;
});
