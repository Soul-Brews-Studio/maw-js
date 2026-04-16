import { describe, it, expect, mock } from "bun:test";
import { join } from "path";
import type { InvokeContext } from "../../../plugin/types";

const root = join(import.meta.dir, "../../..");

const { mockConfigModule } = await import("../../../../test/helpers/mock-config");
mock.module(join(root, "config"), () => mockConfigModule(() => ({ host: "localhost", port: 3456 })));

const mockAgentData = {
  agents: [
    {
      name: "neo",
      totalTokens: 12000,
      estimatedCost: 0.5,
      sessions: 3,
      turns: 42,
      lastActive: "2026-04-13T00:00:00Z",
    },
  ],
  total: { agents: 1, sessions: 3, tokens: 12000, cost: 0.5 },
};

(global as any).fetch = mock(async (_url: string) =>
  new Response(JSON.stringify(mockAgentData), { status: 200 }),
);

const { default: handler } = await import("./index");

describe("costs plugin", () => {
  it("CLI surface — returns ok with cost table", async () => {
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("COST TRACKING");
    expect(result.output).toContain("neo");
  });

  it("API surface — returns ok with cost table", async () => {
    const ctx: InvokeContext = { source: "api", args: {} };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("COST TRACKING");
  });

  it("handles empty agents gracefully", async () => {
    (global as any).fetch = mock(async () =>
      new Response(JSON.stringify({ agents: [], total: { agents: 0, sessions: 0, tokens: 0, cost: 0 } }), { status: 200 }),
    );
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no session data");
  });

  it("returns ok:false when server is unreachable", async () => {
    (global as any).fetch = mock(async () => { throw new Error("ECONNREFUSED"); });
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("maw serve");
  });
});
