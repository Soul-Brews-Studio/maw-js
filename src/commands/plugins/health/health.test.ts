import { describe, it, expect, mock } from "bun:test";
import { join } from "path";
import type { InvokeContext } from "../../../plugin/types";

const root = join(import.meta.dir, "../../..");

mock.module(join(root, "config"), () => ({
  loadConfig: () => ({ host: "localhost", port: 3456, peers: [] }),
  cfgTimeout: () => 2000,
  getEnvVars: () => ({}),
  buildCommand: () => "echo test",
  saveConfig: () => {},
}));

// Mock the health impl directly — do NOT mock child_process (leaks globally in Bun 1.3)
mock.module("./impl", () => ({
  cmdHealth: async () => {
    console.log("maw health — localhost:3456");
    console.log("tmux server: running (2 sessions)");
    console.log("pm2: maw online (pid 1234)");
  },
}));

const { default: handler } = await import("./index");

describe("health plugin", () => {
  it("CLI surface — returns ok with health output", async () => {
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw health");
  });

  it("API surface — returns ok with health output", async () => {
    const ctx: InvokeContext = { source: "api", args: {} };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw health");
  });

  it("reports tmux server in output", async () => {
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("tmux server");
  });

  it("accepts extra args gracefully (no-op)", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["--verbose"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
  });
});
