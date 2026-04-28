/**
 * Tests for src/config/types.ts — typed defaults constant D.
 *
 * Ensures default values for intervals, timeouts, limits, and hmacWindowSeconds
 * are sensible and present. These are the fallback values used throughout maw-js.
 */
import { describe, it, expect } from "bun:test";
import { D } from "../../src/config/types";

describe("D (typed defaults)", () => {
  describe("intervals", () => {
    it("has all expected keys", () => {
      const keys = Object.keys(D.intervals);
      expect(keys).toContain("capture");
      expect(keys).toContain("sessions");
      expect(keys).toContain("status");
      expect(keys).toContain("teams");
      expect(keys).toContain("preview");
      expect(keys).toContain("peerFetch");
      expect(keys).toContain("crashCheck");
    });

    it("all values are positive numbers", () => {
      for (const [key, val] of Object.entries(D.intervals)) {
        expect(typeof val).toBe("number");
        expect(val).toBeGreaterThan(0);
      }
    });

    it("capture is fast (< 200ms)", () => {
      expect(D.intervals.capture).toBeLessThanOrEqual(200);
    });

    it("peerFetch is slower than status", () => {
      expect(D.intervals.peerFetch).toBeGreaterThan(D.intervals.status);
    });
  });

  describe("timeouts", () => {
    it("has all expected keys", () => {
      const keys = Object.keys(D.timeouts);
      expect(keys).toContain("http");
      expect(keys).toContain("health");
      expect(keys).toContain("ping");
      expect(keys).toContain("pty");
      expect(keys).toContain("workspace");
      expect(keys).toContain("shellInit");
      expect(keys).toContain("wakeRetry");
      expect(keys).toContain("wakeVerify");
    });

    it("all values are positive numbers", () => {
      for (const [, val] of Object.entries(D.timeouts)) {
        expect(typeof val).toBe("number");
        expect(val).toBeGreaterThan(0);
      }
    });

    it("wakeRetry is shorter than wakeVerify", () => {
      expect(D.timeouts.wakeRetry).toBeLessThan(D.timeouts.wakeVerify);
    });
  });

  describe("limits", () => {
    it("has all expected keys", () => {
      const keys = Object.keys(D.limits);
      expect(keys).toContain("feedMax");
      expect(keys).toContain("feedDefault");
      expect(keys).toContain("feedHistory");
      expect(keys).toContain("logsMax");
      expect(keys).toContain("logsDefault");
      expect(keys).toContain("logsTruncate");
      expect(keys).toContain("messageTruncate");
      expect(keys).toContain("ptyCols");
      expect(keys).toContain("ptyRows");
    });

    it("all values are positive integers", () => {
      for (const [, val] of Object.entries(D.limits)) {
        expect(typeof val).toBe("number");
        expect(val).toBeGreaterThan(0);
        expect(Number.isInteger(val)).toBe(true);
      }
    });

    it("feedMax >= feedDefault", () => {
      expect(D.limits.feedMax).toBeGreaterThanOrEqual(D.limits.feedDefault);
    });

    it("logsMax >= logsDefault", () => {
      expect(D.limits.logsMax).toBeGreaterThanOrEqual(D.limits.logsDefault);
    });
  });

  describe("hmacWindowSeconds", () => {
    it("is a positive number", () => {
      expect(D.hmacWindowSeconds).toBeGreaterThan(0);
    });

    it("defaults to 300 (5 minutes)", () => {
      expect(D.hmacWindowSeconds).toBe(300);
    });
  });
});
