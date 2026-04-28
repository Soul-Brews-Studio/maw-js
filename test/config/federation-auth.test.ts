/**
 * Tests for hashBody, sign, verify, isLoopback, signHeaders from
 * src/lib/federation-auth.ts.
 * Pure crypto + classification — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { hashBody, sign, verify, isLoopback, signHeaders } from "../../src/lib/federation-auth";

// ─── hashBody ───────────────────────────────────────────────────────────────

describe("hashBody", () => {
  it("returns empty for null", () => {
    expect(hashBody(null)).toBe("");
  });

  it("returns empty for undefined", () => {
    expect(hashBody(undefined)).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(hashBody("")).toBe("");
  });

  it("returns empty for empty Uint8Array", () => {
    expect(hashBody(new Uint8Array(0))).toBe("");
  });

  it("returns hex sha256 for non-empty string", () => {
    const hash = hashBody("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns consistent hash for same input", () => {
    expect(hashBody("test")).toBe(hashBody("test"));
  });

  it("returns different hash for different input", () => {
    expect(hashBody("a")).not.toBe(hashBody("b"));
  });

  it("handles Uint8Array body", () => {
    const buf = new Uint8Array([1, 2, 3]);
    const hash = hashBody(buf);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── sign / verify ──────────────────────────────────────────────────────────

describe("sign", () => {
  it("returns hex HMAC string", () => {
    const sig = sign("secret", "POST", "/api/send", 1000);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = sign("key", "GET", "/api/test", 1234);
    const b = sign("key", "GET", "/api/test", 1234);
    expect(a).toBe(b);
  });

  it("differs with different token", () => {
    const a = sign("key1", "GET", "/path", 100);
    const b = sign("key2", "GET", "/path", 100);
    expect(a).not.toBe(b);
  });

  it("differs with different method", () => {
    const a = sign("key", "GET", "/path", 100);
    const b = sign("key", "POST", "/path", 100);
    expect(a).not.toBe(b);
  });

  it("differs with different path", () => {
    const a = sign("key", "GET", "/a", 100);
    const b = sign("key", "GET", "/b", 100);
    expect(a).not.toBe(b);
  });

  it("v2 signature differs from v1 (bodyHash present)", () => {
    const v1 = sign("key", "POST", "/path", 100);
    const v2 = sign("key", "POST", "/path", 100, "bodyhash");
    expect(v1).not.toBe(v2);
  });
});

describe("verify", () => {
  it("accepts valid v1 signature within time window", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign("token", "POST", "/api/send", ts);
    expect(verify("token", "POST", "/api/send", ts, sig)).toBe(true);
  });

  it("accepts valid v2 signature within time window", () => {
    const ts = Math.floor(Date.now() / 1000);
    const bh = hashBody("body");
    const sig = sign("token", "POST", "/api/send", ts, bh);
    expect(verify("token", "POST", "/api/send", ts, sig, bh)).toBe(true);
  });

  it("rejects wrong token", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign("token", "GET", "/path", ts);
    expect(verify("wrong", "GET", "/path", ts, sig)).toBe(false);
  });

  it("rejects expired timestamp", () => {
    const ts = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const sig = sign("token", "GET", "/path", ts);
    expect(verify("token", "GET", "/path", ts, sig)).toBe(false);
  });

  it("rejects tampered signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verify("token", "GET", "/path", ts, "0".repeat(64))).toBe(false);
  });

  it("rejects mismatched body hash in v2", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign("token", "POST", "/path", ts, "hash-a");
    expect(verify("token", "POST", "/path", ts, sig, "hash-b")).toBe(false);
  });
});

// ─── isLoopback ─────────────────────────────────────────────────────────────

describe("isLoopback", () => {
  it("returns true for 127.0.0.1", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopback("::1")).toBe(true);
  });

  it("returns true for ::ffff:127.0.0.1", () => {
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns true for localhost", () => {
    expect(isLoopback("localhost")).toBe(true);
  });

  it("returns true for 127.x.x.x subnet", () => {
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("127.255.255.255")).toBe(true);
  });

  it("returns false for public IP", () => {
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isLoopback(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLoopback("")).toBe(false);
  });
});

// ─── signHeaders ────────────────────────────────────────────────────────────

describe("signHeaders", () => {
  it("returns timestamp and signature headers", () => {
    const h = signHeaders("token", "GET", "/path");
    expect(h["X-Maw-Timestamp"]).toBeDefined();
    expect(h["X-Maw-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits auth version for v1 (no body)", () => {
    const h = signHeaders("token", "GET", "/path");
    expect(h["X-Maw-Auth-Version"]).toBeUndefined();
  });

  it("includes v2 auth version when body provided", () => {
    const h = signHeaders("token", "POST", "/path", "body");
    expect(h["X-Maw-Auth-Version"]).toBe("v2");
  });

  it("produces verifiable signature", () => {
    const h = signHeaders("secret", "POST", "/api/send");
    const ts = parseInt(h["X-Maw-Timestamp"]);
    expect(verify("secret", "POST", "/api/send", ts, h["X-Maw-Signature"])).toBe(true);
  });
});
