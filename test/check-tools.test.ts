import { describe, it, expect } from "bun:test";
import { checkTool, TOOLS } from "../src/commands/plugins/check/impl";
import type { InvokeContext } from "../src/plugin/types";

describe("check-tools impl", () => {
  it("checkTool — returns present:false for missing binary", () => {
    const r = checkTool("__nonexistent_tool_xyz_12345__");
    expect(r.present).toBe(false);
    expect(r.version).toBeUndefined();
  });

  it("checkTool — detects git and extracts version", () => {
    const r = checkTool("git");
    expect(r.present).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+/);
  });

  it("TOOLS list — required tools sorted alphabetically", () => {
    const required = TOOLS.filter(t => t.category === "required").map(t => t.name);
    expect(required).toEqual([...required].sort());
  });

  it("TOOLS list — optional tools sorted alphabetically", () => {
    const optional = TOOLS.filter(t => t.category === "optional").map(t => t.name);
    expect(optional).toEqual([...optional].sort());
  });

  it("TOOLS list — all tools have installUrl", () => {
    for (const t of TOOLS) {
      expect(t.installUrl).toBeTruthy();
    }
  });
});

describe("check plugin handler", () => {
  it("returns ok with output containing tool sections", async () => {
    const { default: handler } = await import("../src/commands/plugins/check/index");
    const ctx: InvokeContext = { source: "cli", args: ["tools"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Required:");
    expect(result.output).toContain("Optional");
  });

  it("defaults to tools subcommand when no args", async () => {
    const { default: handler } = await import("../src/commands/plugins/check/index");
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Required:");
  });

  it("unknown subcommand returns ok with usage hint", async () => {
    const { default: handler } = await import("../src/commands/plugins/check/index");
    const ctx: InvokeContext = { source: "cli", args: ["unknown"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage:");
  });
});
