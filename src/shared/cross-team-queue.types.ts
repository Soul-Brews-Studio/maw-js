// cross-team-queue.types.ts — shared contract between FORGE backend + VELA UI
// Author: FORGE Oracle — 2026-04-18
// Approved: ADR-002 (~/david-oracle/ψ/memory/forge/adrs/ADR-002_cross-team-queue-api.md)
// Schema version: 1 (bump on breaking change; supersede via /v2 namespace)
//
// Adopted from VELA's §3.2 schema proposal with FORGE refinements:
//   R1: schemaVersion field mandatory
//   R2: mtime retained alongside ageHours
//   R3: parseErrorCount summary alongside errors[]

// ─── Team classification ────────────────────────────────────────────────

/**
 * Team roster — HARDCODED v2.1 per ADR-002 + VELA §3.3.
 * Drift between this and VELA's src/lib/teams.ts = retro item (tracked).
 * v2.2 promote to ~/david-oracle/ψ/memory/shared/team-roster-v1.yaml.
 */
export const TEAM_ROSTER = {
  software: ["helm", "forge", "vela", "arch", "nexus", "pace", "watchdog", "weaver", "sage"],
  business: ["david", "david-cos", "pulse"],
  cross: ["leo"],
} as const;

export type TeamName = keyof typeof TEAM_ROSTER;

// ─── Core record ────────────────────────────────────────────────────────

/**
 * A single cross-team decision waiting for action.
 * Materialized from ~/david-oracle/ψ/memory/<oracle>/inbox/*.md
 * with action_required: yes.
 */
export interface CrossTeamQueueItem {
  /** Stable ID — sha256 of absolute file path, first 12 hex chars. */
  id: string;

  /** Absolute file path (for UI "open in editor" action). */
  path: string;

  /** Path relative to vault root (for compact display). */
  relPath: string;

  /** Filename only (basename). */
  filename: string;

  /** Frontmatter `from:` field (sender oracle name, lowercased, -oracle suffix stripped). */
  from: string;

  /** Recipient — from directory path (authoritative per VELA §3.4). */
  to: string;

  /** Frontmatter `type:` — free-form string (dvl-request | handoff | peer-welcome | fyi | ...). */
  type: string;

  /** Frontmatter `tags:` array (empty if missing). */
  tags: string[];

  /** Frontmatter `confidence:` — "high" | "medium" | "low" (default: "medium" if absent). */
  confidence: "high" | "medium" | "low";

  /** Parsed from `action_required:` — boolean. */
  actionRequired: boolean;

  /** If `action_required: yes (some reason)` — the reason text. Null if plain "yes". */
  actionHint: string | null;

  /** Normalized priority — "high" | "medium" | "low" (inferred from frontmatter or tags). */
  priority: "high" | "medium" | "low";

  /** Frontmatter `date:` (ISO yyyy-mm-dd). */
  date: string;

  /** Hours elapsed since `date:` (float; computed at scan time). */
  ageHours: number;

  /** File mtime in epoch ms (for fallback sort when `date` is stale but file was touched). */
  mtime: number;

  /** First H1 of body after frontmatter (or first 120 chars if no H1). */
  title: string;

  /** First ~200 chars of body after frontmatter (for hover/preview UI). */
  preview: string;

  /** Team classification per TEAM_ROSTER ("software" | "business" | "cross" | "unknown"). */
  team: TeamName | "unknown";

  /** Frontmatter `related:` array — raw paths (empty if missing). */
  related: string[];

  /** File size in bytes. */
  size: number;
}

// ─── API response shapes ────────────────────────────────────────────────

export interface CrossTeamQueueStats {
  byTeam: Record<string, number>;
  byType: Record<string, number>;
  byRecipient: Record<string, number>;
  /** Oldest item's ageHours (0 if empty queue). */
  oldestAgeHours: number;
}

export interface CrossTeamQueueParseError {
  path: string;
  reason: string;
}

export interface CrossTeamQueueResponse {
  /** Schema version — bump on breaking changes. */
  schemaVersion: 1;

  /** Wall-clock timestamp of scan (ISO-8601). */
  scannedAt: string;

  /** Count of inbox files seen during scan (includes parse-failed). */
  scannedFileCount: number;

  /** Count of files with parse errors (summary of errors.length). */
  parseErrorCount: number;

  /** Count of items returned (post-filter). */
  total: number;

  /** Flat list — sortable / virtualizable by UI. */
  items: CrossTeamQueueItem[];

  /** Per-recipient grouping — common "whose inbox has action items" view. */
  byRecipient: Record<string, CrossTeamQueueItem[]>;

  /** Aggregated counts for UI chips / summary panels. */
  stats: CrossTeamQueueStats;

  /** Oracles with zero action_required items (useful for "all clear" view). */
  emptyInboxes: string[];

  /** Per-file parse failures. Never drop items silently (Principle 2). */
  errors: CrossTeamQueueParseError[];
}

// ─── Query parameters ───────────────────────────────────────────────────

export interface CrossTeamQueueQuery {
  /** Filter to specific team(s). Empty = all. */
  team?: string;

  /** Filter to specific recipient(s) — comma-separated list. */
  recipient?: string;

  /** Filter to specific type(s) — comma-separated list. */
  type?: string;

  /** "yes" (default) | "no" | "all". */
  actionRequired?: "yes" | "no" | "all";

  /** Numeric cutoff — only items with ageHours <= this. */
  maxAgeHours?: number;

  /** Per-recipient cap for byRecipient grouping. */
  limit?: number;
}

// ─── Error envelope (on 5xx) ────────────────────────────────────────────

export interface CrossTeamQueueErrorResponse {
  schemaVersion: 1;
  error: "scan-failed" | "permission-denied" | "internal";
  message: string;
}
