/**
 * PR-A smoke test — invokes the cross-team-queue handler directly and
 * asserts the empty QueueResponse wire contract.
 *
 * No mock.module (kept out of test/isolated/). In-process handler call
 * via InvokeContext — same shape the real /api/plugins router uses.
 */

import { describe, it, expect } from "bun:test";
import type { InvokeContext } from "../src/plugin/types";
import type { QueueResponse } from "../src/commands/plugins/cross-team-queue/types";
import handler, { emptyQueueResponse } from "../src/commands/plugins/cross-team-queue/index";

describe("cross-team-queue scaffold (PR-A)", () => {
  const ctx: InvokeContext = { source: "api", args: {} };

  it("emptyQueueResponse() matches the wire contract", () => {
    const r = emptyQueueResponse();
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.schemaVersion).toBe(1);
    expect(r.stats).toEqual({
      totalItems: 0,
      byRecipient: {},
      byType: {},
      oldestAgeHours: null,
      newestAgeHours: null,
    });
  });

  it("handler returns ok + JSON-serialised empty QueueResponse", async () => {
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(typeof result.output).toBe("string");

    const parsed = JSON.parse(result.output!) as QueueResponse;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.items).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.stats.totalItems).toBe(0);
    expect(parsed.stats.oldestAgeHours).toBeNull();
    expect(parsed.stats.newestAgeHours).toBeNull();
  });
});
