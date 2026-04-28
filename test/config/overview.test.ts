/**
 * Tests for src/commands/plugins/overview/impl.ts — pure layout/formatting functions.
 * No tmux, no network.
 */
import { describe, it, expect } from "bun:test";
import {
  buildTargets, paneColor, paneTitle, processMirror,
  pickLayout, chunkTargets, PANES_PER_PAGE,
} from "../../src/commands/plugins/overview/impl";
import type { OverviewTarget } from "../../src/commands/plugins/overview/impl";

// ─── buildTargets ────────────────────────────────────────────────

describe("buildTargets", () => {
  const sessions = [
    { name: "1-neo", windows: [{ index: 1, name: "neo-oracle", active: true }] },
    { name: "2-pim", windows: [{ index: 1, name: "pim-oracle", active: true }] },
    { name: "0-overview", windows: [{ index: 1, name: "overview", active: true }] },
    { name: "plain", windows: [{ index: 1, name: "shell", active: true }] },
  ] as any;

  it("filters to numbered sessions excluding 0-overview", () => {
    const targets = buildTargets(sessions, []);
    expect(targets).toHaveLength(2);
    expect(targets.map(t => t.oracle)).toEqual(["neo", "pim"]);
  });

  it("applies filter by oracle name", () => {
    const targets = buildTargets(sessions, ["neo"]);
    expect(targets).toHaveLength(1);
    expect(targets[0].oracle).toBe("neo");
  });

  it("returns empty for no matches", () => {
    expect(buildTargets(sessions, ["nonexistent"])).toHaveLength(0);
  });

  it("strips numeric prefix for oracle name", () => {
    const targets = buildTargets(sessions, []);
    expect(targets[0].oracle).toBe("neo");
    expect(targets[0].session).toBe("1-neo");
  });
});

// ─── paneColor ───────────────────────────────────────────────────

describe("paneColor", () => {
  it("returns a color string", () => {
    expect(paneColor(0)).toContain("colour");
  });

  it("cycles through colors", () => {
    const c0 = paneColor(0);
    const c1 = paneColor(1);
    expect(c0).not.toBe(c1);
    // After 10 colors, wraps around
    expect(paneColor(10)).toBe(c0);
  });
});

// ─── paneTitle ───────────────────────────────────────────────────

describe("paneTitle", () => {
  it("formats oracle with session:window", () => {
    const t: OverviewTarget = { oracle: "neo", session: "1-neo", window: 2, windowName: "main" };
    expect(paneTitle(t)).toBe("neo (1-neo:2)");
  });
});

// ─── processMirror ───────────────────────────────────────────────

describe("processMirror", () => {
  it("limits to N visible lines from end", () => {
    const raw = "line1\nline2\nline3\nline4\nline5";
    const result = processMirror(raw, 3);
    expect(result.split("\n").filter(l => l.trim()).length).toBe(3);
  });

  it("filters empty lines from content", () => {
    const raw = "line1\n\n\nline2\n\nline3";
    const result = processMirror(raw, 10);
    // Content lines should have empty lines removed
    const contentLines = result.trimStart().split("\n");
    expect(contentLines).toEqual(["line1", "line2", "line3"]);
  });

  it("normalizes long separator lines", () => {
    const raw = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    const result = processMirror(raw, 5);
    expect(result).toContain("─".repeat(60));
  });

  it("pads short output with newlines", () => {
    const raw = "only one line";
    const result = processMirror(raw, 5);
    // Should have 4 padding newlines + 1 content line
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── pickLayout ──────────────────────────────────────────────────

describe("pickLayout", () => {
  it("uses even-horizontal for 1-2 panes", () => {
    expect(pickLayout(1)).toBe("even-horizontal");
    expect(pickLayout(2)).toBe("even-horizontal");
  });

  it("uses tiled for 3+ panes", () => {
    expect(pickLayout(3)).toBe("tiled");
    expect(pickLayout(9)).toBe("tiled");
  });
});

// ─── chunkTargets ────────────────────────────────────────────────

describe("chunkTargets", () => {
  const targets = Array.from({ length: 20 }, (_, i) => ({
    session: `${i}-test`, window: 1, windowName: "main", oracle: `oracle-${i}`,
  }));

  it("splits into pages of PANES_PER_PAGE", () => {
    const pages = chunkTargets(targets);
    expect(pages).toHaveLength(Math.ceil(20 / PANES_PER_PAGE));
    expect(pages[0]).toHaveLength(PANES_PER_PAGE);
  });

  it("last page has remainder", () => {
    const pages = chunkTargets(targets);
    const lastPage = pages[pages.length - 1];
    expect(lastPage.length).toBe(20 % PANES_PER_PAGE || PANES_PER_PAGE);
  });

  it("returns single page for small input", () => {
    const small = targets.slice(0, 3);
    expect(chunkTargets(small)).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(chunkTargets([])).toHaveLength(0);
  });
});
