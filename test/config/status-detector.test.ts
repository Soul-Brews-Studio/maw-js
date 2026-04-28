/**
 * Tests for StatusDetector state management from src/engine/status.ts.
 * Tests getStatus, getCrashedAgents, clearCrashed, pruneState, markRealFeedEvent.
 * These are pure state operations — no tmux needed.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { StatusDetector, markRealFeedEvent } from "../../src/engine/status";

type SessionInfo = {
  name: string;
  windows: { index: number; name: string; active: boolean }[];
};

describe("StatusDetector", () => {
  let detector: StatusDetector;

  beforeEach(() => {
    detector = new StatusDetector();
  });

  describe("getStatus", () => {
    it("returns null for unknown target", () => {
      expect(detector.getStatus("session:0")).toBeNull();
    });
  });

  describe("getCrashedAgents", () => {
    it("returns empty for fresh detector", () => {
      const sessions: SessionInfo[] = [
        { name: "01-pulse", windows: [{ index: 0, name: "pulse", active: false }] },
      ];
      expect(detector.getCrashedAgents(sessions)).toEqual([]);
    });

    it("returns empty when no sessions", () => {
      expect(detector.getCrashedAgents([])).toEqual([]);
    });
  });

  describe("clearCrashed", () => {
    it("does not throw for unknown target", () => {
      expect(() => detector.clearCrashed("nonexistent:0")).not.toThrow();
    });
  });

  describe("pruneState", () => {
    it("does not throw on empty sessions", () => {
      expect(() => detector.pruneState([])).not.toThrow();
    });

    it("does not throw when no state to prune", () => {
      const sessions: SessionInfo[] = [
        { name: "01-pulse", windows: [{ index: 0, name: "pulse", active: true }] },
      ];
      expect(() => detector.pruneState(sessions)).not.toThrow();
    });
  });
});

describe("markRealFeedEvent", () => {
  it("does not throw", () => {
    expect(() => markRealFeedEvent("pulse")).not.toThrow();
  });

  it("can be called multiple times", () => {
    markRealFeedEvent("pulse");
    markRealFeedEvent("pulse");
    markRealFeedEvent("neo");
    // No assertion needed — just verifying no errors
  });
});
