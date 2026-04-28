/**
 * Tests for src/engine/status.ts — StatusDetector pure state methods.
 * Tests only the state management parts (getStatus, getCrashedAgents,
 * clearCrashed, pruneState) without the async detect() method (uses tmux).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { StatusDetector } from "../../src/engine/status";

describe("StatusDetector", () => {
  let detector: StatusDetector;

  beforeEach(() => {
    detector = new StatusDetector();
  });

  describe("getStatus", () => {
    it("returns null for unknown target", () => {
      expect(detector.getStatus("unknown:1")).toBeNull();
    });
  });

  describe("getCrashedAgents", () => {
    it("returns empty array for fresh detector", () => {
      const sessions = [
        { name: "1-neo", windows: [{ index: 1, name: "neo-oracle", active: true }] },
      ];
      expect(detector.getCrashedAgents(sessions)).toEqual([]);
    });

    it("returns empty for sessions with no windows", () => {
      expect(detector.getCrashedAgents([{ name: "empty", windows: [] }])).toEqual([]);
    });

    it("returns empty for empty sessions", () => {
      expect(detector.getCrashedAgents([])).toEqual([]);
    });
  });

  describe("clearCrashed", () => {
    it("does not throw for unknown target", () => {
      expect(() => detector.clearCrashed("unknown:1")).not.toThrow();
    });
  });

  describe("pruneState", () => {
    it("does not throw with empty sessions", () => {
      expect(() => detector.pruneState([])).not.toThrow();
    });

    it("does not throw with active sessions", () => {
      const sessions = [
        { name: "1-neo", windows: [{ index: 1, name: "neo-oracle", active: true }] },
      ];
      expect(() => detector.pruneState(sessions)).not.toThrow();
    });
  });

  describe("markRealFeedEvent", () => {
    // markRealFeedEvent is module-level, not a class method — import separately
    it("is importable and callable", async () => {
      const { markRealFeedEvent } = await import("../../src/engine/status");
      expect(() => markRealFeedEvent("test-oracle")).not.toThrow();
    });
  });
});
