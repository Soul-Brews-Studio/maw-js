// cross-team-queue.ts — GET /api/cross-team-queue
// Author: FORGE Oracle — 2026-04-18 (ADR-002 Day 1 scaffold)
//
// STAGE: Day 1 scaffold — returns schema-valid stub so VELA UI can bind to
// the contract shape. Day 2 replaces the stub body with real filesystem
// scan + frontmatter parse. No behavioral change to the response envelope.

import { Elysia } from "elysia";
import type {
  CrossTeamQueueResponse,
  CrossTeamQueueQuery,
} from "../shared/cross-team-queue.types";

export const crossTeamQueueApi = new Elysia();

crossTeamQueueApi.get("/cross-team-queue", ({ query }) => {
  const q: CrossTeamQueueQuery = {
    team: query?.team,
    recipient: query?.recipient,
    type: query?.type,
    actionRequired: query?.actionRequired as "yes" | "no" | "all" | undefined,
    maxAgeHours: query?.maxAgeHours ? Number(query.maxAgeHours) : undefined,
    limit: query?.limit ? Number(query.limit) : undefined,
  };

  // Day 1 scaffold: empty schema-valid stub. Contract shape is real; data is not.
  // Day 2: replace with scanInbox(q) from ./cross-team-queue-scan.ts
  const response: CrossTeamQueueResponse & { _scaffoldNote: string } = {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    scannedFileCount: 0,
    parseErrorCount: 0,
    total: 0,
    items: [],
    byRecipient: {},
    stats: {
      byTeam: {},
      byType: {},
      byRecipient: {},
      oldestAgeHours: 0,
    },
    emptyInboxes: [],
    errors: [],
    _scaffoldNote:
      "Day 1 scaffold — schema-valid stub. Day 2 adds filesystem scan of " +
      "~/david-oracle/ψ/memory/*/inbox/*.md with frontmatter parse. " +
      "VELA scaffolds UI off ~/david-oracle/ψ/memory/forge/writing/cross-team-queue-fixture-v1.json until Day 3 integration. " +
      "Query params acknowledged but not yet applied: " + JSON.stringify(q) + ". " +
      "See ADR-002 for design + schema contract.",
  };

  return response;
});
