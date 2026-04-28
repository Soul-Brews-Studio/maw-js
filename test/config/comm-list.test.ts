/**
 * Tests for src/commands/shared/comm-list.ts — renderSessionName.
 * Pure string formatting function.
 */
import { describe, it, expect } from "bun:test";
import { renderSessionName } from "../../src/commands/shared/comm-list";

describe("renderSessionName", () => {
  it("renders normal session with cyan color", () => {
    const result = renderSessionName("maw");
    expect(result).toContain("\x1b[36m");
    expect(result).toContain("maw");
    expect(result).not.toContain("[view]");
  });

  it("renders view session dimmed with [view] tag", () => {
    const result = renderSessionName("mawjs-view");
    expect(result).toContain("\x1b[90m");
    expect(result).toContain("[view]");
  });

  it("renders maw-view as view session", () => {
    const result = renderSessionName("maw-view");
    expect(result).toContain("[view]");
  });

  it("does not treat non-view suffix as view", () => {
    const result = renderSessionName("viewfinder");
    expect(result).not.toContain("[view]");
  });

  it("handles numeric-prefixed view session", () => {
    const result = renderSessionName("105-skills-view");
    expect(result).toContain("[view]");
  });
});
