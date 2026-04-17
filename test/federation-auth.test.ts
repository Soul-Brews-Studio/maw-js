import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { sign, verify, isLoopback, signHeaders, hashBody } from "../src/lib/federation-auth";

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

// --- v2 body-hash signatures (D#2 — prevents captured-sig body-swap) ---

describe("hashBody", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("empty/undefined/null body → empty string (v1 marker)", () => {
    expect(hashBody("")).toBe("");
    expect(hashBody(undefined)).toBe("");
    expect(hashBody(null)).toBe("");
    expect(hashBody(new Uint8Array(0))).toBe("");
  });

  test("string body → 64-char hex digest", () => {
    expect(hashBody("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same string → same hash (deterministic)", () => {
    expect(hashBody("hello")).toBe(hashBody("hello"));
  });

  test("different strings → different hashes", () => {
    expect(hashBody("hello")).not.toBe(hashBody("hello2"));
  });

  test("Uint8Array body hashes same bytes as string", () => {
    const s = '{"target":"x","text":"y"}';
    const u = new TextEncoder().encode(s);
    expect(hashBody(s)).toBe(hashBody(u));
  });
});

describe("sign/verify with bodyHash (v2)", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("v2 round-trip — same body hash verifies", () => {
    const ts = Math.floor(Date.now() / 1000);
    const bh = hashBody('{"target":"x","text":"hello"}');
    const sig = sign(token, "POST", "/api/send", ts, bh);
    expect(verify(token, "POST", "/api/send", ts, sig, bh)).toBe(true);
  });

  test("v2 sig + different body-hash → false (the body-swap attack is blocked)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const bhSigned = hashBody('{"target":"x","text":"original"}');
    const bhReplayed = hashBody('{"target":"x","text":"attacker-payload"}');
    const sig = sign(token, "POST", "/api/send", ts, bhSigned);
    expect(verify(token, "POST", "/api/send", ts, sig, bhReplayed)).toBe(false);
  });

  test("v1 sig + any body-hash on verify → false (version mismatch)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sigV1 = sign(token, "POST", "/api/send", ts);
    // Verifier thinks it's v2 (has a body hash), but signature is v1
    const bh = hashBody('{"target":"x"}');
    expect(verify(token, "POST", "/api/send", ts, sigV1, bh)).toBe(false);
  });

  test("v2 sig verified as v1 (no body hash) → false (version mismatch)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sigV2 = sign(token, "POST", "/api/send", ts, hashBody("any"));
    expect(verify(token, "POST", "/api/send", ts, sigV2)).toBe(false);
  });

  test("v1 sig + no bodyHash on verify → true (backward compat path)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sigV1 = sign(token, "POST", "/api/send", ts);
    expect(verify(token, "POST", "/api/send", ts, sigV1)).toBe(true);
  });

  test("timestamp still enforced in v2 (old captured sig rejected)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 400;
    const bh = hashBody('{"x":1}');
    const sig = sign(token, "POST", "/api/send", oldTs, bh);
    expect(verify(token, "POST", "/api/send", oldTs, sig, bh)).toBe(false);
  });
});

describe("signHeaders with body (v2)", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("no body → v1 headers (no version header)", () => {
    const h = signHeaders(token, "POST", "/api/send");
    expect(h["X-Maw-Timestamp"]).toBeDefined();
    expect(h["X-Maw-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["X-Maw-Auth-Version"]).toBeUndefined();
  });

  test("body provided → v2 headers (includes version)", () => {
    const h = signHeaders(token, "POST", "/api/send", '{"x":1}');
    expect(h["X-Maw-Auth-Version"]).toBe("v2");
    expect(h["X-Maw-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty body string → v1 (no version header; matches 'no body')", () => {
    const h = signHeaders(token, "POST", "/api/send", "");
    expect(h["X-Maw-Auth-Version"]).toBeUndefined();
  });

  test("v2 signature verifies when reconstructed with same body hash", () => {
    const body = '{"target":"x","text":"hello"}';
    const h = signHeaders(token, "POST", "/api/send", body);
    const ts = parseInt(h["X-Maw-Timestamp"], 10);
    const bh = hashBody(body);
    expect(verify(token, "POST", "/api/send", ts, h["X-Maw-Signature"], bh)).toBe(true);
  });

  test("v2 signature does NOT verify with swapped body hash (the attack)", () => {
    const realBody = '{"target":"x","text":"original"}';
    const attackerBody = '{"target":"x","text":"payload"}';
    const h = signHeaders(token, "POST", "/api/send", realBody);
    const ts = parseInt(h["X-Maw-Timestamp"], 10);
    const bhAttacker = hashBody(attackerBody);
    expect(verify(token, "POST", "/api/send", ts, h["X-Maw-Signature"], bhAttacker)).toBe(false);
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
