/**
 * Tests for createToken, verifyToken, extractToken from src/lib/auth.ts.
 * HMAC token lifecycle — no mocking needed (loadConfig reads from existing config).
 */
import { describe, it, expect } from "bun:test";
import { createToken, verifyToken, extractToken } from "../../src/lib/auth";

describe("createToken + verifyToken", () => {
  it("creates a token with two parts separated by dot", () => {
    const token = createToken();
    expect(token.split(".")).toHaveLength(2);
  });

  it("round-trips: created token is verifiable", () => {
    const token = createToken();
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.iat).toBeGreaterThan(0);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
    expect(typeof payload!.node).toBe("string");
  });

  it("rejects tampered token", () => {
    const token = createToken();
    const tampered = token.slice(0, -1) + "X";
    expect(verifyToken(tampered)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifyToken("")).toBeNull();
  });

  it("rejects random garbage", () => {
    expect(verifyToken("not.a.valid.token")).toBeNull();
    expect(verifyToken("abc")).toBeNull();
  });

  it("rejects token with invalid base64 payload", () => {
    expect(verifyToken("!!!invalid!!!.sig")).toBeNull();
  });

  it("token expiry is ~24 hours", () => {
    const token = createToken();
    const payload = verifyToken(token)!;
    const expiryMs = payload.exp - payload.iat;
    const hours24 = 24 * 60 * 60 * 1000;
    expect(expiryMs).toBe(hours24);
  });

  it("creates unique tokens across time", async () => {
    const t1 = createToken();
    await new Promise((r) => setTimeout(r, 2));
    const t2 = createToken();
    expect(t1).not.toBe(t2);
  });
});

describe("extractToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer my-token-123" },
    });
    expect(extractToken(req)).toBe("my-token-123");
  });

  it("extracts token from query parameter", () => {
    const req = new Request("http://localhost/api/test?token=query-token-456");
    expect(extractToken(req)).toBe("query-token-456");
  });

  it("prefers Bearer header over query param", () => {
    const req = new Request("http://localhost/api/test?token=query", {
      headers: { Authorization: "Bearer header" },
    });
    expect(extractToken(req)).toBe("header");
  });

  it("returns null when no token present", () => {
    const req = new Request("http://localhost/api/test");
    expect(extractToken(req)).toBeNull();
  });

  it("returns null for non-Bearer auth header", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractToken(req)).toBeNull();
  });
});
