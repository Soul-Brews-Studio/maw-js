/**
 * Tests for renderSessionName from src/commands/shared/comm-list.ts.
 * Pure function — ANSI formatting for session names.
 */
import { describe, it, expect } from "bun:test";
import { renderSessionName } from "../../src/commands/shared/comm-list";

describe("renderSessionName", () => {
  it("renders normal session in cyan", () => {
    const result = renderSessionName("08-mawjs");
    expect(result).toContain("08-mawjs");
    expect(result).toContain("\x1b[36m"); // cyan
    expect(result).not.toContain("[view]");
  });

  it("renders view session dimmed with [view] tag", () => {
    const result = renderSessionName("08-mawjs-view");
    expect(result).toContain("08-mawjs-view");
    expect(result).toContain("\x1b[90m"); // dim
    expect(result).toContain("[view]");
  });

  it("renders maw-view as view session", () => {
    const result = renderSessionName("maw-view");
    expect(result).toContain("[view]");
  });

  it("does not mark non-view suffix as view", () => {
    const result = renderSessionName("overview");
    expect(result).not.toContain("[view]");
    expect(result).toContain("\x1b[36m"); // cyan
  });

  it("handles single-word session names", () => {
    const result = renderSessionName("main");
    expect(result).toContain("main");
    expect(result).not.toContain("[view]");
  });
});
