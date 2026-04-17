import { describe, it, expect, mock } from "bun:test";
import { join } from "path";

// Mock config so cmdCostsDaily can build its base URL in isolation.
import { mockConfigModule } from "../helpers/mock-config";
mock.module("../../src/config", () =>
  mockConfigModule(() => ({ host: "localhost", port: 3456 })),
);

import type { InvokeContext } from "../../src/plugin/types";
const { default: handler } = await import("../../src/commands/plugins/costs/index");

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockDailyData = {
  window: 7,
  buckets: [
    "2026-04-11",
    "2026-04-12",
    "2026-04-13",
    "2026-04-14",
    "2026-04-15",
    "2026-04-16",
    "2026-04-17",
  ],
  agents: [
    {
      name: "neo",
      dailyCosts: [0.1, 0.2, 0.5, 1.4, 1.2, 0.6, 0.3],
      totalCost: 4.3,
      hadActivity: Array(7).fill(true),
    },
  ],
  total: { cost: 4.3, agents: 1 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("costs plugin — --daily flag", () => {
  it("--daily renders sparkline rows and DAILY COSTS header", async () => {
    (global as any).fetch = mock(async () =>
      new Response(JSON.stringify(mockDailyData), { status: 200 }),
    );
    const ctx: InvokeContext = { source: "cli", args: ["--daily", "7"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("DAILY COSTS");
    expect(result.output).toContain("neo");
    // At least one sparkline character present
    expect(result.output).toMatch(/[▁▂▃▄▅▆▇█░]/);
    // TOTAL row present
    expect(result.output).toContain("TOTAL");
  });

  it("--daily --json returns raw JSON without sparkline", async () => {
    (global as any).fetch = mock(async () =>
      new Response(JSON.stringify(mockDailyData), { status: 200 }),
    );
    const ctx: InvokeContext = { source: "cli", args: ["--daily", "--json"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}");
    expect(parsed.agents[0].dailyCosts).toHaveLength(7);
    expect(parsed.buckets).toHaveLength(7);
    // No sparkline chars in JSON output
    expect(result.output).not.toMatch(/[▁▂▃▄▅▆▇█░]/);
  });

  it("bare --daily (no value) defaults to 7 days", async () => {
    // arg parses --daily typed as Number with no value → NaN → should fall back to 7
    let capturedUrl = "";
    (global as any).fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(mockDailyData), { status: 200 });
    });
    const ctx: InvokeContext = { source: "cli", args: ["--daily"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain("days=7");
  });

  it("--daily with empty window returns graceful message", async () => {
    (global as any).fetch = mock(async () =>
      new Response(
        JSON.stringify({
          window: 7,
          buckets: [],
          agents: [],
          total: { cost: 0, agents: 0 },
        }),
        { status: 200 },
      ),
    );
    const ctx: InvokeContext = { source: "cli", args: ["--daily"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no activity");
  });

  it("--daily with server error returns ok:false with maw serve hint", async () => {
    (global as any).fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ctx: InvokeContext = { source: "cli", args: ["--daily"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("maw serve");
  });

  it("--daily with single-agent single-bucket renders █", async () => {
    const singleBucket = {
      window: 1,
      buckets: ["2026-04-17"],
      agents: [
        {
          name: "scout",
          dailyCosts: [2.5],
          totalCost: 2.5,
          hadActivity: [true],
        },
      ],
      total: { cost: 2.5, agents: 1 },
    };
    (global as any).fetch = mock(async () =>
      new Response(JSON.stringify(singleBucket), { status: 200 }),
    );
    const ctx: InvokeContext = { source: "cli", args: ["--daily", "1"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("█");
    expect(result.output).toContain("$2.50");
  });

  it("--daily with mixed-agent data shows ░ for absent days", async () => {
    const mixedData = {
      window: 4,
      buckets: ["2026-04-14", "2026-04-15", "2026-04-16", "2026-04-17"],
      agents: [
        {
          name: "oss-scaffold",
          dailyCosts: [0, 0, 0.5, 1.0],
          totalCost: 1.5,
          hadActivity: [false, false, true, true],
        },
      ],
      total: { cost: 1.5, agents: 1 },
    };
    (global as any).fetch = mock(async () =>
      new Response(JSON.stringify(mixedData), { status: 200 }),
    );
    const ctx: InvokeContext = { source: "cli", args: ["--daily", "4"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    // ░ for absent days, block chars for active days
    expect(result.output).toContain("░");
    expect(result.output).toMatch(/[▁▂▃▄▅▆▇█]/);
  });
});
