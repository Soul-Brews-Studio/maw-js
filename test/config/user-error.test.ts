/**
 * Tests for UserError class and isUserError guard from src/core/util/user-error.ts.
 * Pure class + type guard — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { UserError, isUserError } from "../../src/core/util/user-error";

describe("UserError", () => {
  it("creates with message", () => {
    const err = new UserError("bad input");
    expect(err.message).toBe("bad input");
  });

  it("has name 'UserError'", () => {
    expect(new UserError("x").name).toBe("UserError");
  });

  it("has isUserError brand", () => {
    expect(new UserError("x").isUserError).toBe(true);
  });

  it("is instance of Error", () => {
    expect(new UserError("x")).toBeInstanceOf(Error);
  });

  it("has stack trace", () => {
    const err = new UserError("oops");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("oops");
  });
});

describe("isUserError", () => {
  it("returns true for UserError", () => {
    expect(isUserError(new UserError("x"))).toBe(true);
  });

  it("returns false for regular Error", () => {
    expect(isUserError(new Error("x"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isUserError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isUserError(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isUserError("error")).toBe(false);
  });

  it("returns false for plain object", () => {
    expect(isUserError({ isUserError: true })).toBe(false);
  });

  it("returns true for Error with isUserError brand", () => {
    const err = new Error("x") as any;
    err.isUserError = true;
    expect(isUserError(err)).toBe(true);
  });
});
