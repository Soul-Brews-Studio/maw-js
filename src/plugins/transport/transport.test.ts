import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { InvokeContext } from "../../../plugin/types";

// Mock the transport command
mock.module("../../shared/transport", () => ({
  cmdTransportStatus: async () => {
    console.log("Transport Status  (node: local)");
    console.log("  1. ●  tmux               connected  (local)");
  },
}));

describe("transport plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;

  beforeEach(async () => {
    const mod = await import("./index");
    handler = mod.default;
  });

  it("cli: default (no subcommand) runs status", async () => {
    const result = await handler({ source: "cli", args: [] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Transport Status");
  });

  it("cli: explicit 'status' subcommand runs status", async () => {
    const result = await handler({ source: "cli", args: ["status"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Transport Status");
  });

  it("api: default surface runs status", async () => {
    const result = await handler({ source: "api", args: {} });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Transport Status");
  });

  it("peer: unknown subcommand returns error", async () => {
    const result = await handler({ source: "cli", args: ["unknown"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown subcommand");
  });
});
