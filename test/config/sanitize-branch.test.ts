/**
 * Tests for sanitizeBranchName from src/commands/shared/wake-resolve-impl.ts.
 * Pure string transform, no side effects.
 */
import { describe, it, expect } from "bun:test";
import { sanitizeBranchName } from "../../src/commands/shared/wake-resolve-impl";

describe("sanitizeBranchName", () => {
  it("lowercases the name", () => {
    expect(sanitizeBranchName("MyBranch")).toBe("mybranch");
  });

  it("replaces spaces with dashes", () => {
    expect(sanitizeBranchName("my branch name")).toBe("my-branch-name");
  });

  it("strips invalid chars (including /)", () => {
    expect(sanitizeBranchName("feat/add@stuff!")).toBe("feataddstuff");
  });

  it("collapses consecutive dots", () => {
    expect(sanitizeBranchName("a..b...c")).toBe("a.b.c");
  });

  it("strips leading/trailing dash or dot", () => {
    expect(sanitizeBranchName("-branch-")).toBe("branch");
    expect(sanitizeBranchName(".branch.")).toBe("branch");
  });

  it("truncates to 50 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranchName(long).length).toBeLessThanOrEqual(50);
  });

  it("handles empty string", () => {
    expect(sanitizeBranchName("")).toBe("");
  });

  it("preserves valid chars (a-z, 0-9, -, _, .)", () => {
    expect(sanitizeBranchName("feat-123_v2.0")).toBe("feat-123_v2.0");
  });
});
