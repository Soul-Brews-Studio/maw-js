/**
 * from-signing-outgoing.test.ts — #804 Step 4 SIGN (v3 outbound).
 *
 * Pinpoints the outbound v3 from-signing layer:
 *   - signRequestV3() computes HMAC over the v2-extended payload
 *     (`METHOD:PATH:TIMESTAMP:BODY_SHA256:FROM`) and binds the body.
 *   - signHeadersV3() emits the four-header set with `X-Maw-Auth-Version: v3`
 *     and reuses `X-Maw-Timestamp` (numeric seconds) — no new clock primitive.
 *   - resolveFromAddress() builds `<config.oracle ?? "mawjs">:<config.node>`
 *     per the #804 research and returns null without a node.
 *   - curlFetch's `from` option stacks v3 headers on top of v2 token signing,
 *     "auto" derives via config, and silently skips when no node.
 *
 * Isolated because:
 *   - `loadConfig` is mock.module-stubbed (a process-global mutation).
 *   - getPeerKey() reads <CONFIG_DIR>/peer-key on first call; we pin
 *     MAW_PEER_KEY before any import to avoid filesystem dependencies.
 *
 * Crypto (createHmac) is NEVER mocked — sign here, recompute the expected
 * digest with the same helper, and assert equality. That mirrors the
 * federation-auth test pattern shared with #801 / Step 1.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";
import { createHmac } from "crypto";
import type { MawConfig } from "../../src/config";

// ─── Pin MAW_PEER_KEY before importing target modules ───────────────────────
const PEER_KEY = "deadbeef".repeat(8); // 64-char hex
process.env.MAW_PEER_KEY = PEER_KEY;
delete process.env.CLAUDE_AGENT_NAME;

// ─── Capture real config module BEFORE installing mock ──────────────────────
const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;

let mockActive = false;
let configStore: Partial<MawConfig> = {};

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

// Import targets AFTER mocks so their import graph resolves through stubs.
const {
  signRequestV3,
  signHeadersV3,
  resolveFromAddress,
  hashBody,
  DEFAULT_ORACLE,
} = await import("../../src/lib/federation-auth");

const { curlFetch } = await import("../../src/core/transport/curl-fetch");

// ─── Harness ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockActive = true;
  configStore = {};
});

afterEach(() => {
  mockActive = false;
});

afterAll(() => {
  mockActive = false;
  delete process.env.MAW_PEER_KEY;
});

const FROM = "neo:white";
const TOKEN = "0123456789abcdef-federation-token";

// ════════════════════════════════════════════════════════════════════════════
// signRequestV3 — payload contract
// ════════════════════════════════════════════════════════════════════════════

describe("signRequestV3 — METHOD:PATH:TS:BODY_SHA256:FROM", () => {
  test("matches a hand-rolled createHmac over the canonical payload", () => {
    const ts = 1_700_000_000;
    const body = JSON.stringify({ target: "white:neo", text: "hi" });
    const { signature, bodyHash } = signRequestV3({
      peerKey: PEER_KEY,
      fromAddress: FROM,
      method: "post", // input lowercased — implementation must uppercase
      path: "/api/send",
      timestamp: ts,
      body,
    });
    const expected = createHmac("sha256", PEER_KEY)
      .update(`POST:/api/send:${ts}:${hashBody(body)}:${FROM}`)
      .digest("hex");
    expect(signature).toBe(expected);
    expect(bodyHash).toBe(hashBody(body));
  });

  test("body-swap → different signature (v3 body-binds, replay path closed)", () => {
    const ts = 1_700_000_000;
    const a = signRequestV3({
      peerKey: PEER_KEY, fromAddress: FROM, method: "POST", path: "/api/send",
      timestamp: ts, body: JSON.stringify({ text: "original" }),
    }).signature;
    const b = signRequestV3({
      peerKey: PEER_KEY, fromAddress: FROM, method: "POST", path: "/api/send",
      timestamp: ts, body: JSON.stringify({ text: "swapped" }),
    }).signature;
    expect(a).not.toBe(b);
  });

  test("from-swap with same body → different signature (sender identity is bound)", () => {
    const ts = 1_700_000_000;
    const body = JSON.stringify({ x: 1 });
    const a = signRequestV3({ peerKey: PEER_KEY, fromAddress: "neo:white", method: "POST", path: "/x", timestamp: ts, body }).signature;
    const b = signRequestV3({ peerKey: PEER_KEY, fromAddress: "neo:mba", method: "POST", path: "/x", timestamp: ts, body }).signature;
    expect(a).not.toBe(b);
  });

  test("missing peerKey / fromAddress → throws (callers cannot silently emit a bogus header)", () => {
    expect(() => signRequestV3({ peerKey: "", fromAddress: FROM, method: "GET", path: "/x", timestamp: 1 })).toThrow();
    expect(() => signRequestV3({ peerKey: PEER_KEY, fromAddress: "", method: "GET", path: "/x", timestamp: 1 })).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// signHeadersV3 — wire shape
// ════════════════════════════════════════════════════════════════════════════

describe("signHeadersV3 — outgoing wire shape", () => {
  test("emits exactly X-Maw-From / X-Maw-Signature-V3 / X-Maw-Timestamp / X-Maw-Auth-Version", () => {
    const before = Math.floor(Date.now() / 1000);
    const h = signHeadersV3({
      peerKey: PEER_KEY,
      fromAddress: FROM,
      method: "POST",
      path: "/api/send",
      body: JSON.stringify({ x: 1 }),
    });
    const after = Math.floor(Date.now() / 1000);

    expect(Object.keys(h).sort()).toEqual(
      ["X-Maw-Auth-Version", "X-Maw-From", "X-Maw-Signature-V3", "X-Maw-Timestamp"],
    );
    expect(h["X-Maw-From"]).toBe(FROM);
    expect(h["X-Maw-Auth-Version"]).toBe("v3");
    expect(h["X-Maw-Signature-V3"]).toMatch(/^[0-9a-f]{64}$/);
    const ts = parseInt(h["X-Maw-Timestamp"], 10);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("explicit timestamp passes through (verifier round-trip seam)", () => {
    const ts = 1_750_000_000;
    const h = signHeadersV3({ peerKey: PEER_KEY, fromAddress: FROM, method: "GET", path: "/api/identity", timestamp: ts });
    expect(h["X-Maw-Timestamp"]).toBe(String(ts));
    const expected = createHmac("sha256", PEER_KEY)
      .update(`GET:/api/identity:${ts}::${FROM}`) // body-less → empty bodyHash slot
      .digest("hex");
    expect(h["X-Maw-Signature-V3"]).toBe(expected);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveFromAddress — config-driven
// ════════════════════════════════════════════════════════════════════════════

describe("resolveFromAddress — <config.oracle ?? mawjs>:<config.node>", () => {
  test("explicit oracle wins", () => {
    expect(resolveFromAddress({ oracle: "neo", node: "white" })).toBe("neo:white");
  });

  test("missing oracle → DEFAULT_ORACLE fallback", () => {
    expect(resolveFromAddress({ node: "white" })).toBe(`${DEFAULT_ORACLE}:white`);
    expect(DEFAULT_ORACLE).toBe("mawjs");
  });

  test("missing node → null (caller skips v3-signing in single-node posture)", () => {
    expect(resolveFromAddress({ oracle: "neo" })).toBeNull();
    expect(resolveFromAddress({})).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// curlFetch + from — end-to-end against a real Bun.serve
// ════════════════════════════════════════════════════════════════════════════

describe("curlFetch with `from` — v3 stacks on v2 over the wire", () => {
  test("from: explicit string + token → BOTH v2 and v3 headers reach the peer", async () => {
    configStore = { node: "white", federationToken: TOKEN };
    const captured: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        for (const [k, v] of req.headers.entries()) captured[k.toLowerCase()] = v;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/api/send`;
      const body = JSON.stringify({ target: "mba:homekeeper", text: "ping" });
      const res = await curlFetch(url, { method: "POST", body, from: FROM });
      expect(res.ok).toBe(true);

      // v3 layer
      expect(captured["x-maw-from"]).toBe(FROM);
      expect(captured["x-maw-auth-version"]).toBe("v3");
      expect(captured["x-maw-signature-v3"]).toMatch(/^[0-9a-f]{64}$/);
      // v2 layer (token-signed) survives alongside
      expect(captured["x-maw-signature"]).toMatch(/^[0-9a-f]{64}$/);
      // Single shared timestamp — both signatures bind the same instant
      expect(captured["x-maw-timestamp"]).toMatch(/^\d+$/);

      // v3 signature reproduces the canonical payload
      const ts = parseInt(captured["x-maw-timestamp"], 10);
      const expected = createHmac("sha256", PEER_KEY)
        .update(`POST:/api/send:${ts}:${hashBody(body)}:${FROM}`)
        .digest("hex");
      expect(captured["x-maw-signature-v3"]).toBe(expected);
    } finally {
      server.stop(true);
    }
  });

  test('from: "auto" + config.oracle + node → derives "<oracle>:<node>"', async () => {
    configStore = { node: "white", oracle: "neo" };
    const captured: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        for (const [k, v] of req.headers.entries()) captured[k.toLowerCase()] = v;
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      const res = await curlFetch(`http://127.0.0.1:${server.port}/api/send`, {
        method: "POST", body: "{}", from: "auto",
      });
      expect(res.ok).toBe(true);
      expect(captured["x-maw-from"]).toBe("neo:white");
      expect(captured["x-maw-auth-version"]).toBe("v3");
    } finally {
      server.stop(true);
    }
  });

  test('from: "auto" with no oracle → DEFAULT_ORACLE prefix', async () => {
    configStore = { node: "white" };
    const captured: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        for (const [k, v] of req.headers.entries()) captured[k.toLowerCase()] = v;
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      await curlFetch(`http://127.0.0.1:${server.port}/api/identity`, { from: "auto" });
      expect(captured["x-maw-from"]).toBe("mawjs:white");
    } finally {
      server.stop(true);
    }
  });

  test('from: "auto" with no node → silently skips v3 (no X-Maw-From header)', async () => {
    configStore = {}; // no node
    const captured: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        for (const [k, v] of req.headers.entries()) captured[k.toLowerCase()] = v;
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      const res = await curlFetch(`http://127.0.0.1:${server.port}/api/identity`, { from: "auto" });
      expect(res.ok).toBe(true);
      expect(captured["x-maw-from"]).toBeUndefined();
      expect(captured["x-maw-signature-v3"]).toBeUndefined();
      expect(captured["x-maw-auth-version"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("no `from` option → only legacy v1/v2 headers, no v3 (back-compat)", async () => {
    configStore = { node: "white", federationToken: TOKEN };
    const captured: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        for (const [k, v] of req.headers.entries()) captured[k.toLowerCase()] = v;
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      await curlFetch(`http://127.0.0.1:${server.port}/api/sessions`);
      expect(captured["x-maw-from"]).toBeUndefined();
      expect(captured["x-maw-signature-v3"]).toBeUndefined();
      expect(captured["x-maw-auth-version"]).toBeUndefined();
      expect(captured["x-maw-signature"]).toMatch(/^[0-9a-f]{64}$/); // v2 still rides
    } finally {
      server.stop(true);
    }
  });
});
