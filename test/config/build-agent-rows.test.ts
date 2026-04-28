/**
 * Tests for buildAgentRows from src/commands/shared/agents.ts.
 * Pure function — builds agent rows from raw pane/window data.
 */
import { describe, it, expect } from "bun:test";
import { buildAgentRows } from "../../src/commands/shared/agents";

function makePane(command: string, target: string, pid?: number) {
  return { command, target, pid };
}

describe("buildAgentRows", () => {
  const windowNames = new Map([
    ["main:0", "neo-oracle"],
    ["main:1", "mawjs"],
    ["dev:0", "pulse-oracle"],
    ["dev:1", "shell"],
  ]);

  it("returns oracle windows by default", () => {
    const panes = [
      makePane("claude", "main:0.0", 1234),
      makePane("claude", "dev:0.0", 5678),
    ];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows).toHaveLength(2);
    expect(rows[0].oracle).toBe("neo");
    expect(rows[0].window).toBe("neo-oracle");
    expect(rows[0].session).toBe("main");
    expect(rows[0].node).toBe("white");
    expect(rows[0].pid).toBe(1234);
  });

  it("filters non-oracle windows by default", () => {
    const panes = [
      makePane("claude", "main:1.0"),
      makePane("zsh", "dev:1.0"),
    ];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows).toHaveLength(0);
  });

  it("includes all windows with opts.all", () => {
    const panes = [
      makePane("claude", "main:0.0"),
      makePane("zsh", "main:1.0"),
    ];
    const rows = buildAgentRows(panes, windowNames, "white", { all: true });
    expect(rows).toHaveLength(2);
  });

  it("detects active state for non-shell commands", () => {
    const panes = [makePane("claude", "main:0.0")];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].state).toBe("active");
  });

  it("detects idle state for shell commands", () => {
    const panes = [makePane("zsh", "main:0.0")];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].state).toBe("idle");
  });

  it("detects idle for bash/sh/fish/dash", () => {
    for (const shell of ["bash", "sh", "fish", "dash"]) {
      const panes = [makePane(shell, "main:0.0")];
      const rows = buildAgentRows(panes, windowNames, "white");
      expect(rows[0].state).toBe("idle");
    }
  });

  it("strips -oracle suffix for oracle name", () => {
    const panes = [makePane("node", "dev:0.0")];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].oracle).toBe("pulse");
  });

  it("skips panes with invalid target format", () => {
    const panes = [makePane("claude", "invalid-target")];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows).toHaveLength(0);
  });

  it("handles missing pid as null", () => {
    const panes = [makePane("claude", "main:0.0")];
    const rows = buildAgentRows(panes, windowNames, "white");
    expect(rows[0].pid).toBeNull();
  });

  it("returns empty for empty panes", () => {
    expect(buildAgentRows([], windowNames, "white")).toEqual([]);
  });

  it("handles missing window name gracefully", () => {
    const panes = [makePane("claude", "unknown:99.0")];
    const rows = buildAgentRows(panes, new Map(), "white", { all: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].window).toBe("");
    expect(rows[0].oracle).toBe("");
  });
});
