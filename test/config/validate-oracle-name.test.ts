/**
 * Tests for src/core/fleet/validate.ts — assertValidOracleName.
 * Pure validation (throws UserError, no I/O).
 */
import { describe, it, expect } from "bun:test";
import { assertValidOracleName } from "../../src/core/fleet/validate";

describe("assertValidOracleName", () => {
  it("accepts normal oracle names", () => {
    expect(() => assertValidOracleName("neo")).not.toThrow();
    expect(() => assertValidOracleName("homekeeper")).not.toThrow();
    expect(() => assertValidOracleName("pim-oracle")).not.toThrow();
  });

  it("rejects names ending in -view", () => {
    expect(() => assertValidOracleName("neo-view")).toThrow("-view");
  });

  it("suggests name without -view suffix", () => {
    try {
      assertValidOracleName("test-view");
    } catch (e: any) {
      expect(e.message).toContain("'test'");
    }
  });

  it("accepts -view in the middle", () => {
    expect(() => assertValidOracleName("viewer-bot")).not.toThrow();
    expect(() => assertValidOracleName("preview-oracle")).not.toThrow();
  });

  it("accepts names containing view without hyphen", () => {
    expect(() => assertValidOracleName("overview")).not.toThrow();
  });

  it("rejects exactly -view at end", () => {
    expect(() => assertValidOracleName("my-view")).toThrow();
  });

  it("thrown error is a UserError", () => {
    try {
      assertValidOracleName("bad-view");
    } catch (e: any) {
      expect(e.isUserError).toBe(true);
    }
  });
});
