/**
 * Tests for newRequestId from src/core/consent/request.ts — pure-ish (crypto random).
 */
import { describe, it, expect } from "bun:test";
import { newRequestId } from "../../src/core/consent/request";

describe("newRequestId", () => {
  it("returns a 24-char hex string", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newRequestId()));
    expect(ids.size).toBe(20);
  });

  it("returns a string", () => {
    expect(typeof newRequestId()).toBe("string");
  });

  it("has exactly 24 characters (12 bytes hex-encoded)", () => {
    expect(newRequestId()).toHaveLength(24);
  });
});
