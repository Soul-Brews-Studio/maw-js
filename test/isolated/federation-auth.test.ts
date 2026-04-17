/**
 * federation-auth.ts — HMAC signing + verification + Hono middleware.
 *
 * Security-critical. Issue #385 / alpha.62 caught an HMAC unsigned-request
 * silent failure originating here. Middleware bypass semantics (loopback vs
 * signed non-loopback) carry #191 RCE history — every branch matters.
 *
 * Isolated because we mock.module on one seam federationAuth() imports
 * through:
 *   - src/config   (loadConfig — inject federationToken per-test)
 *
 * Crypto (createHmac / timingSafeEqual) is NEVER mocked — sign+verify of our
 * own output is the cleanest test pair, and real HMAC rules out impostor
 * implementations drifting from production behaviour.
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)`.
 * os.homedir() caching is N/A here (no home lookups inside target).
 *
 * Hono middleware is driven via a real `new Hono()` app.fetch(request, env).
 * `env.server.requestIP(raw)` is what the middleware reads for the TCP
 * source address, so we inject address per-request to drive loopback /
 * non-loopback branches without opening a socket.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { Hono } from "hono";
import type { MawConfig } from "../../src/config";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

let configStore: Partial<MawConfig> = {};

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: (...args: unknown[]) =>
      mockActive
        ? (configStore as MawConfig)
        : (realLoadConfig as (...a: unknown[]) => MawConfig)(...args),
  }),
);

// NB: import target AFTER mocks so its import graph resolves through our stubs.
const {
  sign,
  verify,
  isLoopback,
  signHeaders,
  federationAuth,
} = await import("../../src/lib/federation-auth");

// ─── Harness ────────────────────────────────────────────────────────────────

const origWarn = console.warn;
let warns: string[] = [];

beforeEach(() => {
  mockActive = true;
  configStore = {};
  warns = [];
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
});

afterEach(() => {
  mockActive = false;
  console.warn = origWarn;
});

afterAll(() => {
  mockActive = false;
  console.warn = origWarn;
});

// ─── Hono app factory ───────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono();
  app.use("*", federationAuth());
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

/** Drive the app with a synthetic TCP source address. */
async function fire(
  app: Hono,
  url: string,
  init: RequestInit,
  clientIp: string | undefined,
): Promise<Response> {
  const env = clientIp === undefined
    ? { server: { requestIP: () => undefined } }
    : { server: { requestIP: () => ({ address: clientIp }) } };
  return app.fetch(new Request(url, init), env);
}

const TOKEN = "0123456789abcdef-federation-token";

// ════════════════════════════════════════════════════════════════════════════
// Core crypto — sign
// ════════════════════════════════════════════════════════════════════════════

describe("sign — HMAC-SHA256 over METHOD:PATH:TIMESTAMP", () => {
  test("returns 64-char lowercase hex (SHA-256 digest shape)", () => {
    const out = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  test("deterministic — identical inputs yield identical digest", () => {
    const a = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    const b = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    expect(a).toBe(b);
  });

  test("changing the method changes the digest (payload concat is load-bearing)", () => {
    const post = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    const get = sign(TOKEN, "GET", "/api/send", 1_700_000_000);
    expect(post).not.toBe(get);
  });

  test("changing the path changes the digest", () => {
    const a = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    const b = sign(TOKEN, "POST", "/api/talk", 1_700_000_000);
    expect(a).not.toBe(b);
  });

  test("changing the timestamp changes the digest", () => {
    const a = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    const b = sign(TOKEN, "POST", "/api/send", 1_700_000_001);
    expect(a).not.toBe(b);
  });

  test("changing the token changes the digest (key swap)", () => {
    const a = sign(TOKEN, "POST", "/api/send", 1_700_000_000);
    const b = sign("different-but-also-long-enough", "POST", "/api/send", 1_700_000_000);
    expect(a).not.toBe(b);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Core crypto — verify
// ════════════════════════════════════════════════════════════════════════════

describe("verify — window + timing-safe equality", () => {
  test("sign→verify round-trips for a fresh timestamp", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    expect(verify(TOKEN, "POST", "/api/send", ts, sig)).toBe(true);
  });

  test("timestamp older than ±300s window → false (expired)", () => {
    const ts = Math.floor(Date.now() / 1000) - 301;
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    expect(verify(TOKEN, "POST", "/api/send", ts, sig)).toBe(false);
  });

  test("timestamp in the future beyond window → false (also expired)", () => {
    const ts = Math.floor(Date.now() / 1000) + 600;
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    expect(verify(TOKEN, "POST", "/api/send", ts, sig)).toBe(false);
  });

  test("timestamp exactly at window edge (300s) → true (boundary inclusive)", () => {
    const ts = Math.floor(Date.now() / 1000) - 300;
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    expect(verify(TOKEN, "POST", "/api/send", ts, sig)).toBe(true);
  });

  test("signature length mismatch → early false (short-circuit before timingSafeEqual)", () => {
    const ts = Math.floor(Date.now() / 1000);
    // Truncate to 10 chars — lengths differ, timingSafeEqual would throw.
    expect(verify(TOKEN, "POST", "/api/send", ts, "abcd1234ef")).toBe(false);
  });

  test("signature correct length but wrong bytes → false (HMAC mismatch)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const badSig = "0".repeat(64);
    expect(verify(TOKEN, "POST", "/api/send", ts, badSig)).toBe(false);
  });

  test("signature correct length but non-hex → catch branch returns false (not throw)", () => {
    const ts = Math.floor(Date.now() / 1000);
    // 64 chars, but "zz..." is invalid hex — Buffer.from(..., "hex") yields a
    // shorter buffer, timingSafeEqual throws on length mismatch → caught → false.
    const nonHex = "z".repeat(64);
    expect(verify(TOKEN, "POST", "/api/send", ts, nonHex)).toBe(false);
  });

  test("wrong token rejects a signature produced with the real one", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    expect(verify("different-token-also-long", "POST", "/api/send", ts, sig)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// isLoopback
// ════════════════════════════════════════════════════════════════════════════

describe("isLoopback — TCP source classifier", () => {
  test.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["localhost", true],
    ["127.0.0.2", true],       // starts with 127.
    ["127.255.255.254", true],
    ["10.0.0.1", false],
    ["192.168.1.1", false],
    ["8.8.8.8", false],
    ["::ffff:10.0.0.1", false],
    ["2001:db8::1", false],
    ["", false],
  ] as const)("%s → %s", (addr, expected) => {
    expect(isLoopback(addr)).toBe(expected);
  });

  test("undefined → false (no source address is NEVER loopback)", () => {
    expect(isLoopback(undefined)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// signHeaders
// ════════════════════════════════════════════════════════════════════════════

describe("signHeaders — outgoing HTTP header production", () => {
  test("produces X-Maw-Timestamp (numeric seconds) + X-Maw-Signature (hex)", () => {
    const before = Math.floor(Date.now() / 1000);
    const h = signHeaders(TOKEN, "POST", "/api/send");
    const after = Math.floor(Date.now() / 1000);

    expect(Object.keys(h).sort()).toEqual(["X-Maw-Signature", "X-Maw-Timestamp"]);
    expect(h["X-Maw-Signature"]).toMatch(/^[0-9a-f]{64}$/);

    const ts = parseInt(h["X-Maw-Timestamp"], 10);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("signature matches sign() over the emitted timestamp (headers self-consistent)", () => {
    const h = signHeaders(TOKEN, "POST", "/api/send");
    const ts = parseInt(h["X-Maw-Timestamp"], 10);
    expect(h["X-Maw-Signature"]).toBe(sign(TOKEN, "POST", "/api/send", ts));
  });

  test("verify(...) accepts headers produced by signHeaders (round-trip)", () => {
    const h = signHeaders(TOKEN, "POST", "/api/send");
    const ts = parseInt(h["X-Maw-Timestamp"], 10);
    expect(verify(TOKEN, "POST", "/api/send", ts, h["X-Maw-Signature"])).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hono middleware — bypass branches
// ════════════════════════════════════════════════════════════════════════════

describe("federationAuth() middleware — bypass branches", () => {
  test("no federationToken AND no peers → requests pass (local-only single-node OK)", async () => {
    configStore = {};
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "8.8.8.8");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("non-protected path (e.g. /api/sessions GET) → pass without headers", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/sessions", { method: "GET" }, "8.8.8.8");
    expect(res.status).toBe(200);
  });

  test("loopback 127.0.0.1 on a protected path → pass without headers", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "127.0.0.1");
    expect(res.status).toBe(200);
  });

  test("loopback ::1 on a protected path → pass without headers", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "::1");
    expect(res.status).toBe(200);
  });

  test("/api/feed GET is public (non-POST branch of PROTECTED_POST) → pass", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/feed", { method: "GET" }, "8.8.8.8");
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hono middleware — peers-require-token invariant (Bloom #federation-audit)
// ════════════════════════════════════════════════════════════════════════════
// Non-loopback bind (hasPeers) without federationToken is default-insecure-open
// in pre-fix code: server.ts only logs a warning, middleware happily admits
// anonymous writes. These tests codify the new invariant:
//
//   hasPeers && !federationToken  →  protected endpoints 401
//   unless explicit opt-out (config.allowPeersWithoutToken: true)
//
// Attack-twin scenario (see ψ/lab/federation-audit/paladin-forensic.md §
// "Bypass #1"): a malicious peer reaches a fresh-install node whose operator
// never configured a token; today it gets unauthenticated RCE via /api/send.

describe("federationAuth() middleware — peers-require-token invariant", () => {
  const PEER = { name: "white", url: "http://10.0.0.1:3456" } as any;

  test("peers configured, no token, non-loopback POST /api/send → 401 federation_token_required", async () => {
    configStore = { peers: [PEER] };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "8.8.8.8");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "federation auth required",
      reason: "federation_token_required",
    });
  });

  test("peers configured, no token, loopback POST /api/send → pass (loopback still trusted)", async () => {
    configStore = { peers: [PEER] };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "127.0.0.1");
    expect(res.status).toBe(200);
  });

  test("peers configured, no token, GET /api/sessions → pass (reads remain public)", async () => {
    configStore = { peers: [PEER] };
    const app = makeApp();
    const res = await fire(app, "http://host/api/sessions", { method: "GET" }, "8.8.8.8");
    expect(res.status).toBe(200);
  });

  test("explicit opt-out (allowPeersWithoutToken: true) → legacy behavior preserved", async () => {
    configStore = { peers: [PEER], allowPeersWithoutToken: true };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "8.8.8.8");
    expect(res.status).toBe(200);
  });

  test("validateConfig passes allowPeersWithoutToken through (mawjs review #396)", async () => {
    // Review caught that the config field was silently stripped by
    // validateConfig() because it wasn't in the validator allowlist. Without
    // this validator test the operator-facing escape hatch was reachable
    // from the test store (which bypasses validation) but NOT from
    // maw.config.json in production. That mismatch is the UX bug mawjs
    // flagged.
    const { validateConfig } = await import("../../src/config/validate-ext");
    expect(validateConfig({ allowPeersWithoutToken: true }).allowPeersWithoutToken).toBe(true);
    expect(validateConfig({ allowPeersWithoutToken: false }).allowPeersWithoutToken).toBe(false);
    // Non-boolean values are dropped with a warning (not coerced).
    expect(validateConfig({ allowPeersWithoutToken: "yes" } as Record<string, unknown>).allowPeersWithoutToken).toBeUndefined();
  });

  test("namedPeers also triggers invariant (hasPeers is peers OR namedPeers)", async () => {
    configStore = { namedPeers: [{ name: "bo", url: "http://clubs:3456" }] } as any;
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "8.8.8.8");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "federation auth required",
      reason: "federation_token_required",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hono middleware — reject branches (401 shape is security contract)
// ════════════════════════════════════════════════════════════════════════════

describe("federationAuth() middleware — reject branches", () => {
  test("non-loopback + missing signature → 401 missing_signature", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", { method: "POST" }, "8.8.8.8");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "federation auth required",
      reason: "missing_signature",
    });
  });

  test("signature present but timestamp missing → 401 missing_signature", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", {
      method: "POST",
      headers: { "x-maw-signature": "0".repeat(64) },
    }, "8.8.8.8");
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("missing_signature");
  });

  test("timestamp header NaN → 401 invalid_timestamp", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const res = await fire(app, "http://host/api/send", {
      method: "POST",
      headers: {
        "x-maw-signature": "0".repeat(64),
        "x-maw-timestamp": "not-a-number",
      },
    }, "8.8.8.8");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "federation auth failed",
      reason: "invalid_timestamp",
    });
  });

  test("valid shape but wrong signature bytes → 401 signature_invalid + warn log", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const ts = Math.floor(Date.now() / 1000);
    const res = await fire(app, "http://host/api/send", {
      method: "POST",
      headers: {
        "x-maw-signature": "0".repeat(64),
        "x-maw-timestamp": String(ts),
      },
    }, "203.0.113.5");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("federation auth failed");
    expect(body.reason).toBe("signature_invalid");
    expect(body.delta).toBeUndefined(); // only set for expired
    expect(warns.join("\n")).toContain("signature_invalid");
    expect(warns.join("\n")).toContain("203.0.113.5");
  });

  test("expired timestamp → 401 timestamp_expired + delta field + warn log", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const oldTs = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const sig = sign(TOKEN, "POST", "/api/send", oldTs);
    const res = await fire(app, "http://host/api/send", {
      method: "POST",
      headers: {
        "x-maw-signature": sig,
        "x-maw-timestamp": String(oldTs),
      },
    }, "198.51.100.9");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("timestamp_expired");
    expect(typeof body.delta).toBe("number");
    expect(body.delta).toBeGreaterThanOrEqual(3600);
    expect(warns.join("\n")).toContain("timestamp_expired");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hono middleware — happy path on each protected shape
// ════════════════════════════════════════════════════════════════════════════

describe("federationAuth() middleware — valid-signature passes", () => {
  test("valid HMAC for POST /api/send from non-loopback → pass", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    const res = await fire(app, "http://host/api/send", {
      method: "POST",
      headers: {
        "x-maw-signature": sig,
        "x-maw-timestamp": String(ts),
      },
    }, "203.0.113.5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST /api/feed is protected only for POST — valid HMAC passes", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TOKEN, "POST", "/api/feed", ts);
    const res = await fire(app, "http://host/api/feed", {
      method: "POST",
      headers: {
        "x-maw-signature": sig,
        "x-maw-timestamp": String(ts),
      },
    }, "203.0.113.5");
    expect(res.status).toBe(200);
  });

  test("other PROTECTED set members (e.g. /api/triggers/fire) also accept valid HMAC", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TOKEN, "POST", "/api/triggers/fire", ts);
    const res = await fire(app, "http://host/api/triggers/fire", {
      method: "POST",
      headers: {
        "x-maw-signature": sig,
        "x-maw-timestamp": String(ts),
      },
    }, "203.0.113.5");
    expect(res.status).toBe(200);
  });

  test("non-loopback with no requestIP resolver on env (undefined address) → auth still required", async () => {
    configStore = { federationToken: TOKEN };
    const app = makeApp();
    // clientIp undefined → isLoopback(undefined) === false → full auth enforced.
    const res = await fire(app, "http://host/api/send", { method: "POST" }, undefined);
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("missing_signature");
  });
});
