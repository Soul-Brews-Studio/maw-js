/**
 * cross-team-queue — shared types for inbox items, response, errors, filters.
 *
 * Prior art: #505 built-in router shape by david-oracle. This is a plugin-first
 * reimplementation (not a fork) — same high-level response keys, independent
 * implementation.
 */

export type FrontmatterValue = string | number | boolean | string[];

export interface InboxItem {
  file: string;
  oracle: string;
  recipient?: string;
  team?: string;
  type?: string;
  subject?: string;
  mtime: number;
  ageHours: number;
  frontmatter: Record<string, FrontmatterValue>;
}

export interface ParseError {
  file: string;
  reason: string;
}

export interface QueueStats {
  totalScanned: number;
  totalReturned: number;
  oracles: number;
  byType: Record<string, number>;
}

export interface QueueResponse {
  items: InboxItem[];
  stats: QueueStats;
  errors: ParseError[];
}

export interface QueueFilter {
  recipient?: string;
  team?: string;
  type?: string;
  maxAgeHours?: number;
}
