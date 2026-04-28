/**
 * Tests for src/commands/shared/agents.ts — buildAgentRows.
 * Pure function, no I/O (explicitly documented in source).
 */
import { describe, it, expect } from "bun:test";
import { buildAgentRows } from "../../src/commands/shared/agents";

const windowNames = new Map([
  ["maw:0", "neo-oracle"],
  ["maw:1", "homekeeper-oracle"],
  ["maw:2", "editor"],
  ["dev:0", "shell"],
]);

describe("buildAgentRows", () => {
  it("returns oracle rows only by default", () => {
    const panes = [
      { command: "claude", target: "maw:0.0" },
      { command: "zsh", target: "maw:2.0" },
    ];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows).toHaveLength(1);
    expect(rows[0].oracle).toBe("neo");
    expect(rows[0].window).toBe("neo-oracle");
  });

  it("returns all rows with opts.all", () => {
    const panes = [
      { command: "claude", target: "maw:0.0" },
      { command: "zsh", target: "maw:2.0" },
    ];
    const rows = buildAgentRows(panes, windowNames, "white", { all: true });
    expect(rows).toHaveLength(2);
  });

  it("detects active state for claude/codex/node", () => {
    const panes = [{ command: "claude", target: "maw:0.0" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].state).toBe("active");
  });

  it("detects idle state for shell commands", () => {
    const panes = [{ command: "zsh", target: "maw:1.0" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].state).toBe("idle");
    expect(rows[0].oracle).toBe("homekeeper");
  });

  it("detects idle for bash", () => {
    const panes = [{ command: "bash", target: "maw:0.0" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].state).toBe("idle");
  });

  it("strips -oracle suffix for oracle name", () => {
    const panes = [{ command: "claude", target: "maw:0.0" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].oracle).toBe("neo");
  });

  it("sets empty oracle for non-oracle windows", () => {
    const panes = [{ command: "vim", target: "maw:2.0" }];
    const rows = buildAgentRows(panes, windowNames, "white", { all: true });
    expect(rows[0].oracle).toBe("");
  });

  it("includes node name", () => {
    const panes = [{ command: "claude", target: "maw:0.0" }];
    const rows = buildAgentRows(panes, windowNames, "oracle-world");
    expect(rows[0].node).toBe("oracle-world");
  });

  it("includes pid when available", () => {
    const panes = [{ command: "claude", target: "maw:0.0", pid: 12345 }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].pid).toBe(12345);
  });

  it("sets pid null when not available", () => {
    const panes = [{ command: "claude", target: "maw:0.0" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].pid).toBeNull();
  });

  it("skips panes with invalid target format", () => {
    const panes = [{ command: "claude", target: "invalid" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows).toHaveLength(0);
  });

  it("returns empty for empty panes", () => {
    expect(buildAgentRows([], windowNames, "white")).toEqual([]);
  });

  it("parses session name from target", () => {
    const panes = [{ command: "claude", target: "maw:0.0" }];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].session).toBe("maw");
  });
});
