/**
 * Tests for src/core/runtime/find-window.ts — AmbiguousMatchError class.
 * Pure Error subclass with query and candidates properties.
 */
import { describe, it, expect } from "bun:test";
import { AmbiguousMatchError } from "../../src/core/runtime/find-window";

describe("AmbiguousMatchError", () => {
  it("extends Error", () => {
    const err = new AmbiguousMatchError("neo", ["neo-a", "neo-b"]);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name 'AmbiguousMatchError'", () => {
    const err = new AmbiguousMatchError("neo", ["neo-a", "neo-b"]);
    expect(err.name).toBe("AmbiguousMatchError");
  });

  it("stores query", () => {
    const err = new AmbiguousMatchError("neo", ["a"]);
    expect(err.query).toBe("neo");
  });

  it("stores candidates", () => {
    const err = new AmbiguousMatchError("neo", ["a", "b", "c"]);
    expect(err.candidates).toEqual(["a", "b", "c"]);
  });

  it("includes query in message", () => {
    const err = new AmbiguousMatchError("boom", ["boom-a", "boom-b"]);
    expect(err.message).toContain("boom");
  });

  it("includes candidates in message", () => {
    const err = new AmbiguousMatchError("x", ["x-1", "x-2"]);
    expect(err.message).toContain("x-1");
    expect(err.message).toContain("x-2");
  });

  it("has stack trace", () => {
    const err = new AmbiguousMatchError("x", []);
    expect(err.stack).toBeDefined();
  });

  it("handles empty candidates", () => {
    const err = new AmbiguousMatchError("x", []);
    expect(err.candidates).toEqual([]);
  });

  it("handles single candidate", () => {
    const err = new AmbiguousMatchError("x", ["only"]);
    expect(err.candidates).toHaveLength(1);
  });
});
