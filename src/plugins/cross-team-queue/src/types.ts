/**
 * Wire contract for cross-team-queue.
 *
 * Pre-defined for parallel implementation by team-agents.
 * schemaVersion is the literal `1` — bumps require coordinated migration
 * on consumers (maw plugin install, plugins.lock, any UI).
 */

export interface InboxItem {
  recipient: string;          // who the message is FOR
  sender: string;             // who sent it
  team?: string;              // optional team grouping
  type: string;               // e.g. "handoff", "review", "question", "fyi"
  subject: string;            // first line / title
  body: string;               // markdown body (post-frontmatter)
  path: string;               // absolute file path
  mtime: number;              // raw modification time (epoch ms)
  ageHours: number;           // derived: (Date.now() - mtime) / 3600000
  schemaVersion: 1;
}

export interface QueueFilter {
  recipient?: string;         // exact match (case-insensitive)
  team?: string;              // exact match
  type?: string;              // exact match
  maxAgeHours?: number;       // include items with ageHours <= this
}

export interface QueueStats {
  totalItems: number;
  byRecipient: Record<string, number>;
  byType: Record<string, number>;
  oldestAgeHours: number | null;
  newestAgeHours: number | null;
}

export interface ParseError {
  path: string;
  reason: string;             // human-readable; no stack traces
}

export interface QueueResponse {
  items: InboxItem[];
  stats: QueueStats;
  errors: ParseError[];
  schemaVersion: 1;
}
