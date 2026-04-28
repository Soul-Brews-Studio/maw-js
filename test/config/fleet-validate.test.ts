/**
 * Tests for assertValidOracleName from src/core/fleet/validate.ts.
 * Pure validation — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { assertValidOracleName } from "../../src/core/fleet/validate";
import { UserError } from "../../src/core/util/user-error";

describe("assertValidOracleName", () => {
  it("accepts normal name", () => {
    expect(() => assertValidOracleName("neo")).not.toThrow();
  });

  it("accepts hyphenated name", () => {
    expect(() => assertValidOracleName("boom-oracle")).not.toThrow();
  });

  it("accepts name with numbers", () => {
    expect(() => assertValidOracleName("oracle-42")).not.toThrow();
  });

  it("rejects name ending in -view", () => {
    expect(() => assertValidOracleName("neo-view")).toThrow(UserError);
  });

  it("includes suggestion without -view", () => {
    try {
      assertValidOracleName("neo-view");
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toContain("'neo'");
    }
  });

  it("accepts -view in middle of name", () => {
    expect(() => assertValidOracleName("viewer-oracle")).not.toThrow();
    expect(() => assertValidOracleName("view-neo")).not.toThrow();
  });

  it("rejects exactly -view suffix", () => {
    expect(() => assertValidOracleName("my-great-view")).toThrow();
  });
});
