/**
 * Tests for scaffoldBranchName from src/commands/plugins/bud/from-repo-git.ts.
 * Pure string builder — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { scaffoldBranchName } from "../../src/commands/plugins/bud/from-repo-git";

describe("scaffoldBranchName", () => {
  it("prefixes stem with oracle/scaffold-", () => {
    expect(scaffoldBranchName("neo")).toBe("oracle/scaffold-neo");
  });

  it("handles hyphenated stems", () => {
    expect(scaffoldBranchName("my-oracle")).toBe("oracle/scaffold-my-oracle");
  });

  it("handles stems with numbers", () => {
    expect(scaffoldBranchName("agent42")).toBe("oracle/scaffold-agent42");
  });

  it("handles empty stem", () => {
    expect(scaffoldBranchName("")).toBe("oracle/scaffold-");
  });
});
