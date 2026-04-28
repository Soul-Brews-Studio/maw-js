/**
 * Tests for src/commands/plugins/bud/from-repo.ts — looksLikeUrl + formatPlan.
 * Pure functions.
 */
import { describe, it, expect } from "bun:test";
import { formatPlan } from "../../src/commands/plugins/bud/from-repo";
import type { InjectionPlan } from "../../src/commands/plugins/bud/types";

function makePlan(overrides: Partial<InjectionPlan> = {}): InjectionPlan {
  return {
    target: "/tmp/repo",
    stem: "neo",
    actions: [],
    blockers: [],
    ...overrides,
  };
}

describe("formatPlan", () => {
  it("shows stem and target", () => {
    const output = formatPlan(makePlan());
    expect(output).toContain("neo");
    expect(output).toContain("/tmp/repo");
  });

  it("shows blockers when present", () => {
    const output = formatPlan(makePlan({ blockers: ["ψ/ already exists"] }));
    expect(output).toContain("blocked");
    expect(output).toContain("ψ/ already exists");
  });

  it("shows actions", () => {
    const output = formatPlan(makePlan({
      actions: [
        { kind: "mkdir", path: "ψ/inbox" },
        { kind: "write", path: "CLAUDE.md" },
        { kind: "append", path: ".gitignore", reason: "add ψ/" },
        { kind: "skip", path: ".claude/settings.local.json", reason: "exists" },
      ],
    }));
    expect(output).toContain("mkdir");
    expect(output).toContain("write");
    expect(output).toContain("append");
    expect(output).toContain("skip");
    expect(output).toContain("ψ/inbox");
    expect(output).toContain("CLAUDE.md");
  });

  it("includes reason in parentheses", () => {
    const output = formatPlan(makePlan({
      actions: [{ kind: "append", path: ".gitignore", reason: "add ψ/" }],
    }));
    expect(output).toContain("add ψ/");
  });

  it("blockers short-circuit — no actions shown", () => {
    const output = formatPlan(makePlan({
      blockers: ["fatal error"],
      actions: [{ kind: "write", path: "file.txt" }],
    }));
    expect(output).toContain("blocked");
    expect(output).not.toContain("file.txt");
  });

  it("returns string ending with newline", () => {
    const output = formatPlan(makePlan());
    expect(output.endsWith("\n")).toBe(true);
  });
});
