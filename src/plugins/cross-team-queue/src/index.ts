/**
 * cross-team-queue plugin entry.
 *
 * Scaffold only — scan/filter/aggregate modules ship in follow-up PRs.
 * Returns an empty QueueResponse so the API surface is wired and testable.
 */

import type { QueueResponse, QueueFilter } from "./types";

export async function handle(_filter: QueueFilter = {}): Promise<QueueResponse> {
  return {
    items: [],
    stats: {
      totalItems: 0,
      byRecipient: {},
      byType: {},
      oldestAgeHours: null,
      newestAgeHours: null,
    },
    errors: [],
    schemaVersion: 1,
  };
}

export type { InboxItem, QueueFilter, QueueStats, ParseError, QueueResponse } from "./types";
