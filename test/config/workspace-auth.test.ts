/**
 * Tests for src/api/workspace-auth.ts — wsSign, wsVerify.
 * Pure HMAC functions, same pattern as federation-auth.
 */
import { describe, it, expect } from "bun:test";
import { wsSign, wsVerify } from "../../src/api/workspace-auth";

const TOKEN = "test-workspace-token-minimum-16";

describe("wsSign", () => {
  it("produces hex HMAC signature", () => {
    const sig = wsSign(TOKEN, "POST", "/api/test", 1714200000);
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
  });

  it("is deterministic", () => {
    const a = wsSign(TOKEN, "POST", "/api/test", 1714200000);
    const b = wsSign(TOKEN, "POST", "/api/test", 1714200000);
    expect(a).toBe(b);
  });

  it("changes with different method", () => {
    const a = wsSign(TOKEN, "POST", "/api/test", 1714200000);
    const b = wsSign(TOKEN, "GET", "/api/test", 1714200000);
    expect(a).not.toBe(b);
  });

  it("changes with different path", () => {
    const a = wsSign(TOKEN, "POST", "/api/a", 1714200000);
    const b = wsSign(TOKEN, "POST", "/api/b", 1714200000);
    expect(a).not.toBe(b);
  });

  it("changes with different timestamp", () => {
    const a = wsSign(TOKEN, "POST", "/api/test", 1714200000);
    const b = wsSign(TOKEN, "POST", "/api/test", 1714200001);
    expect(a).not.toBe(b);
  });
});

describe("wsVerify", () => {
  it("accepts valid signature within time window", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = wsSign(TOKEN, "POST", "/api/test", now);
    expect(wsVerify(TOKEN, "POST", "/api/test", now, sig)).toBe(true);
  });

  it("rejects expired timestamp (>5 min)", () => {
    const old = Math.floor(Date.now() / 1000) - 400;
    const sig = wsSign(TOKEN, "POST", "/api/test", old);
    expect(wsVerify(TOKEN, "POST", "/api/test", old, sig)).toBe(false);
  });

  it("rejects wrong signature", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(wsVerify(TOKEN, "POST", "/api/test", now, "a".repeat(64))).toBe(false);
  });

  it("rejects wrong token", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = wsSign(TOKEN, "POST", "/api/test", now);
    expect(wsVerify("wrong-token-padding-16!", "POST", "/api/test", now, sig)).toBe(false);
  });

  it("rejects mismatched length", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(wsVerify(TOKEN, "POST", "/api/test", now, "short")).toBe(false);
  });
});
