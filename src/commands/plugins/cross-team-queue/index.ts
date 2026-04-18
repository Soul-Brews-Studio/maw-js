/**
 * cross-team-queue — plugin-first unified inbox across oracle vaults.
 *
 * PR-A (this file): scaffold only — returns an empty QueueResponse so the
 * wire contract + /api/plugins/cross-team-queue auto-mount is live.
 * PR-B adds scan.ts (fs walker + minimal YAML-subset frontmatter parser).
 * PR-C wires filter + aggregate + adversarial tests.
 *
 * Inspired by #505 (david-oracle). Not derived from it — fresh impl that
 * lives under src/commands/plugins/ per our plugin-first convention.
 */

import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import type { QueueResponse } from "./types";

export const command = {
  name: "cross-team-queue",
  description: "Unified inbox view across oracle vaults (plugin-first).",
};

export function emptyQueueResponse(): QueueResponse {
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

export default async function handler(_ctx: InvokeContext): Promise<InvokeResult> {
  const response = emptyQueueResponse();
  return { ok: true, output: JSON.stringify(response) };
}
