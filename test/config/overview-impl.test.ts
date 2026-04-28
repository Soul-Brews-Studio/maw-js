/**
 * Tests for buildTargets, paneColor, paneTitle, processMirror,
 * pickLayout, chunkTargets from src/commands/plugins/overview/impl.ts.
 * Pure layout/formatting — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import {
  buildTargets,
  paneColor,
  paneTitle,
  processMirror,
  pickLayout,
  chunkTargets,
  PANES_PER_PAGE,
} from "../../src/commands/plugins/overview/impl";
import type { OverviewTarget } from "../../src/commands/plugins/overview/impl";

function makeSessions(items: Array<{ name: string; windows?: Array<{ index: number; name: string; active: boolean }> }>) {
  return items.map(s => ({
    name: s.name,
    windows: s.windows ?? [{ index: 0, name: s.name.replace(/^\d+-/, ""), active: true }],
  }));
}

// ─── buildTargets ───────────────────────────────────────────────────────────

describe("buildTargets", () => {
  it("filters oracle sessions (NN-name format)", () => {
    const sessions = makeSessions([
      { name: "01-neo" },
      { name: "02-pulse" },
      { name: "plain-session" },
    ]);
    const targets = buildTargets(sessions, []);
    expect(targets.length).toBe(2);
    expect(targets.map(t => t.oracle)).toEqual(["neo", "pulse"]);
  });

  it("excludes 0-overview session", () => {
    const sessions = makeSessions([{ name: "0-overview" }, { name: "01-neo" }]);
    const targets = buildTargets(sessions, []);
    expect(targets.length).toBe(1);
    expect(targets[0].oracle).toBe("neo");
  });

  it("applies filters", () => {
    const sessions = makeSessions([{ name: "01-neo" }, { name: "02-pulse" }]);
    const targets = buildTargets(sessions, ["neo"]);
    expect(targets.length).toBe(1);
    expect(targets[0].oracle).toBe("neo");
  });

  it("returns empty for no matching sessions", () => {
    const targets = buildTargets([], []);
    expect(targets).toEqual([]);
  });

  it("strips numeric prefix for oracle name", () => {
    const sessions = makeSessions([{ name: "114-mawjs" }]);
    const targets = buildTargets(sessions, []);
    expect(targets[0].oracle).toBe("mawjs");
  });
});

// ─── paneColor ──────────────────────────────────────────────────────────────

describe("paneColor", () => {
  it("returns a colour string", () => {
    expect(paneColor(0)).toMatch(/^colour\d+$/);
  });

  it("wraps around after 10 colors", () => {
    expect(paneColor(0)).toBe(paneColor(10));
  });

  it("returns different colors for adjacent indices", () => {
    expect(paneColor(0)).not.toBe(paneColor(1));
  });
});

// ─── paneTitle ──────────────────────────────────────────────────────────────

describe("paneTitle", () => {
  it("formats oracle name with session:window", () => {
    const t: OverviewTarget = { session: "01-neo", window: 0, windowName: "neo", oracle: "neo" };
    expect(paneTitle(t)).toBe("neo (01-neo:0)");
  });
});

// ─── processMirror ──────────────────────────────────────────────────────────

describe("processMirror", () => {
  it("limits to requested lines", () => {
    const raw = "line1\nline2\nline3\nline4\nline5";
    const result = processMirror(raw, 3);
    const visible = result.split("\n").filter(l => l.trim() !== "");
    expect(visible.length).toBeLessThanOrEqual(3);
  });

  it("normalizes long separator lines", () => {
    const raw = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    const result = processMirror(raw, 5);
    expect(result).toContain("─");
    expect(result).not.toContain("━");
  });

  it("filters empty lines", () => {
    const raw = "hello\n\n\nworld\n\n";
    const result = processMirror(raw, 10);
    const lines = result.split("\n").filter(l => l.trim() !== "");
    expect(lines).toEqual(["hello", "world"]);
  });

  it("pads when fewer lines than requested", () => {
    const raw = "only one";
    const result = processMirror(raw, 5);
    const parts = result.split("\n");
    expect(parts.length).toBeGreaterThan(1); // has padding newlines
  });
});

// ─── pickLayout ─────────────────────────────────────────────────────────────

describe("pickLayout", () => {
  it("returns even-horizontal for 1-2 panes", () => {
    expect(pickLayout(1)).toBe("even-horizontal");
    expect(pickLayout(2)).toBe("even-horizontal");
  });

  it("returns tiled for 3+ panes", () => {
    expect(pickLayout(3)).toBe("tiled");
    expect(pickLayout(9)).toBe("tiled");
  });
});

// ─── chunkTargets ───────────────────────────────────────────────────────────

describe("chunkTargets", () => {
  it("returns empty for empty input", () => {
    expect(chunkTargets([])).toEqual([]);
  });

  it("returns single page for fewer than PANES_PER_PAGE", () => {
    const targets = Array.from({ length: 5 }, (_, i) => ({
      session: `0${i}`, window: 0, windowName: `w${i}`, oracle: `o${i}`,
    }));
    const pages = chunkTargets(targets);
    expect(pages.length).toBe(1);
    expect(pages[0].length).toBe(5);
  });

  it("splits into multiple pages", () => {
    const targets = Array.from({ length: PANES_PER_PAGE + 3 }, (_, i) => ({
      session: `0${i}`, window: 0, windowName: `w${i}`, oracle: `o${i}`,
    }));
    const pages = chunkTargets(targets);
    expect(pages.length).toBe(2);
    expect(pages[0].length).toBe(PANES_PER_PAGE);
    expect(pages[1].length).toBe(3);
  });

  it("PANES_PER_PAGE is 9", () => {
    expect(PANES_PER_PAGE).toBe(9);
  });
});
