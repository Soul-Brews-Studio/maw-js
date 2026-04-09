import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { sign, verify, isLoopback, signHeaders } from "../src/lib/federation-auth";

// --- isLoopback ---

describe("isLoopback", () => {
  test("recognizes IPv4 loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
  });

  test("recognizes IPv6 loopback", () => {
    expect(isLoopback("::1")).toBe(true);
  });

  test("recognizes IPv4-mapped IPv6 loopback", () => {
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  test("recognizes localhost string", () => {
    expect(isLoopback("localhost")).toBe(true);
  });

  test("recognizes 127.x.x.x range", () => {
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("127.255.255.255")).toBe(true);
  });

  test("rejects real IPs", () => {
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("8.8.8.8")).toBe(false);
  });

  test("rejects undefined/empty", () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback("")).toBe(false);
  });
});

// --- sign / verify ---

describe("sign and verify", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("sign returns a hex string", () => {
    const sig = sign(token, "POST", "/api/send", 1000000);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verify accepts a valid signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = sign(token, "POST", "/api/send", now);
    expect(verify(token, "POST", "/api/send", now, sig)).toBe(true);
  });

  test("verify rejects wrong method", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = sign(token, "POST", "/api/send", now);
    expect(verify(token, "GET", "/api/send", now, sig)).toBe(false);
  });

  test("verify rejects wrong path", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = sign(token, "POST", "/api/send", now);
    expect(verify(token, "POST", "/api/other", now, sig)).toBe(false);
  });

  test("verify rejects wrong token", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = sign(token, "POST", "/api/send", now);
    expect(verify("different-token-also-long-enough", "POST", "/api/send", now, sig)).toBe(false);
  });

  test("verify rejects expired timestamp (>5 min)", () => {
    const old = Math.floor(Date.now() / 1000) - 400; // 6+ minutes ago
    const sig = sign(token, "POST", "/api/send", old);
    expect(verify(token, "POST", "/api/send", old, sig)).toBe(false);
  });

  test("verify accepts timestamp within window", () => {
    const recent = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const sig = sign(token, "POST", "/api/send", recent);
    expect(verify(token, "POST", "/api/send", recent, sig)).toBe(true);
  });
});

// --- signHeaders ---

describe("signHeaders", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("produces X-Maw-Timestamp and X-Maw-Signature", () => {
    const headers = signHeaders(token, "POST", "/api/send");
    expect(headers["X-Maw-Timestamp"]).toBeDefined();
    expect(headers["X-Maw-Signature"]).toBeDefined();
    expect(headers["X-Maw-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("signature is verifiable", () => {
    const headers = signHeaders(token, "POST", "/api/send");
    const ts = parseInt(headers["X-Maw-Timestamp"], 10);
    const sig = headers["X-Maw-Signature"];
    expect(verify(token, "POST", "/api/send", ts, sig)).toBe(true);
  });
});

// --- SECURITY REGRESSION: XFF bypass (CVE-class, see #191) ---

describe("XFF bypass regression guard (#191)", () => {
  test("federation-auth source MUST NOT read X-Forwarded-For or X-Real-IP headers", () => {
    // The XFF bypass was an empirically-verified RCE-equivalent vector
    // (homekeeper's 3-test matrix on mba, 2026-04-08). See #191 / e629d2e.
    //
    // The source contains comments MENTIONING these headers (explaining
    // why they're banned). That's fine — comments don't execute. The test
    // checks that no CODE reads them via c.req.header().
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );

    // Strip comments (// and /* */) to check only executable code
    const codeOnly = source
      .replace(/\/\/.*$/gm, "")          // remove line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // remove block comments

    const lower = codeOnly.toLowerCase();
    expect(lower).not.toContain("x-forwarded-for");
    expect(lower).not.toContain("x-real-ip");
  });

  test("clientIp is derived from requestIP only, not from headers", () => {
    // Verify the source contains the correct pattern: requestIP?.()?.address
    // and does NOT have a fallback chain that includes headers.
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );

    // The patched line should look like:
    //   const clientIp = (c.env as any)?.server?.requestIP?.(c.req.raw)?.address;
    // with NO || c.req.header("x-forwarded-for") fallback.
    expect(source).toContain("requestIP");
    expect(source).not.toContain('header("x-forwarded-for")');
    expect(source).not.toContain('header("x-real-ip")');
  });
});
