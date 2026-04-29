/**
 * cross-team-queue — shared types for the api↔ui contract.
 *
 * Source-of-truth for InboxItem / QueueResponse / etc., consumed by the UI
 * and any other in-tree code. The community plugin lives in the registry
 * monorepo — this file replaces the prior re-export that pointed at
 * `src/commands/plugins/cross-team-queue/types`.
 *
 * Prior art: #505 router shape (david-oracle).
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
