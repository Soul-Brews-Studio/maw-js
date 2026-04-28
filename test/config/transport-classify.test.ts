/**
 * Tests for classifyError from src/core/transport/transport.ts.
 * Pure error classification — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { classifyError } from "../../src/core/transport/transport";

describe("classifyError", () => {
  it("classifies timeout errors", () => {
    expect(classifyError(new Error("ETIMEDOUT"))).toEqual({ reason: "timeout", retryable: true });
    expect(classifyError(new Error("connection timeout"))).toEqual({ reason: "timeout", retryable: true });
    expect(classifyError(new Error("ECONNRESET"))).toEqual({ reason: "timeout", retryable: true });
  });

  it("classifies unreachable errors", () => {
    expect(classifyError(new Error("ECONNREFUSED"))).toEqual({ reason: "unreachable", retryable: true });
    expect(classifyError(new Error("host unreachable"))).toEqual({ reason: "unreachable", retryable: true });
    expect(classifyError(new Error("ENETUNREACH"))).toEqual({ reason: "unreachable", retryable: true });
  });

  it("classifies auth errors", () => {
    expect(classifyError(new Error("401 Unauthorized"))).toEqual({ reason: "auth", retryable: false });
    expect(classifyError(new Error("403 Forbidden"))).toEqual({ reason: "auth", retryable: false });
    expect(classifyError(new Error("authentication failed"))).toEqual({ reason: "auth", retryable: false });
  });

  it("classifies rate limit errors", () => {
    expect(classifyError(new Error("429 Too Many Requests"))).toEqual({ reason: "rate_limit", retryable: true });
    expect(classifyError(new Error("rate limited"))).toEqual({ reason: "rate_limit", retryable: true });
  });

  it("classifies rejected errors", () => {
    expect(classifyError(new Error("400 Bad Request"))).toEqual({ reason: "rejected", retryable: false });
    expect(classifyError(new Error("message rejected"))).toEqual({ reason: "rejected", retryable: false });
    expect(classifyError(new Error("access denied"))).toEqual({ reason: "rejected", retryable: false });
  });

  it("classifies parse errors", () => {
    expect(classifyError(new Error("JSON parse error"))).toEqual({ reason: "parse_error", retryable: false });
    expect(classifyError(new Error("SyntaxError: unexpected"))).toEqual({ reason: "parse_error", retryable: false });
  });

  it("returns unknown for null/undefined", () => {
    expect(classifyError(null)).toEqual({ reason: "unknown", retryable: false });
    expect(classifyError(undefined)).toEqual({ reason: "unknown", retryable: false });
  });

  it("returns unknown for unrecognized error", () => {
    expect(classifyError(new Error("something else"))).toEqual({ reason: "unknown", retryable: false });
  });

  it("handles string errors", () => {
    expect(classifyError("ECONNREFUSED")).toEqual({ reason: "unreachable", retryable: true });
  });

  it("is case insensitive", () => {
    expect(classifyError(new Error("TIMEOUT")).reason).toBe("timeout");
    expect(classifyError(new Error("Unauthorized")).reason).toBe("auth");
  });
});
