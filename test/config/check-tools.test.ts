/**
 * Tests for src/commands/plugins/check/impl.ts — TOOLS constant.
 * Pure data validation.
 */
import { describe, it, expect } from "bun:test";
import { TOOLS } from "../../src/commands/plugins/check/impl";

describe("TOOLS constant", () => {
  it("has at least 5 tools", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(5);
  });

  it("includes required tools: bun, gh, ghq, git, tmux", () => {
    const names = TOOLS.map(t => t.name);
    for (const tool of ["bun", "gh", "ghq", "git", "tmux"]) {
      expect(names).toContain(tool);
    }
  });

  it("all tools have installUrl", () => {
    for (const t of TOOLS) {
      expect(t.installUrl).toBeTruthy();
      expect(t.installUrl.startsWith("http")).toBe(true);
    }
  });

  it("required tools have category 'required'", () => {
    const required = TOOLS.filter(t => t.required);
    expect(required.length).toBeGreaterThanOrEqual(5);
    expect(required.every(t => t.category === "required")).toBe(true);
  });

  it("optional tools have category 'optional'", () => {
    const optional = TOOLS.filter(t => !t.required);
    expect(optional.every(t => t.category === "optional")).toBe(true);
  });

  it("no duplicate names", () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
