/**
 * from-signing-outgoing.test.ts — #804 Step 4 SIGN.
 *
 * Pinpoints the outbound from-signing layer:
 *   - signRequest() emits the three-header trio with the documented payload
 *     shape (`<from>\n<signedAt>\n<METHOD>\n<path>\n<bodyHash>`).
 *   - resolveFromAddress() builds `<oracle>:<node>` from
 *     CLAUDE_AGENT_NAME / tmux / config.node, in that precedence.
 *   - curlFetch's `from` option produces those headers on a real outgoing
 *     request, with the body bound to the signature (body-swap → distinct
 *     digest), and is silently skipped for `from: "auto"` when no node is
 *     configured.
 *
 * Isolated because:
 *   - `loadConfig` is mock.module-stubbed (a process-global mutation).
 *   - getPeerKey() reads <CONFIG_DIR>/peer-key on first call; we pin
 *     MAW_PEER_KEY before any import to avoid filesystem dependencies.
 *
 * Crypto (createHmac) is NEVER mocked — sign here, verify with the same
 * helper, and assert the relationship. That mirrors the federation-auth
 * test pattern (#804 Step 1 ADR + the existing federation-auth.test.ts).
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";
import { createHmac } from "crypto";
import type { MawConfig } from "../../src/config";

// ─── Pin MAW_PEER_KEY before importing target modules ───────────────────────
process.env.MAW_PEER_KEY = "deadbeef".repeat(8); // 64-char hex
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
  signRequest,
  resolveFromAddress,
  hashBody,
} = await import("../../src/lib/federation-auth");

// curlFetch is exercised against a real Bun.serve() — see the section below.
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

const PEER_KEY = "deadbeef".repeat(8);
const FROM = "neo:white";

// ════════════════════════════════════════════════════════════════════════════
// signRequest — header shape + payload contract
// ════════════════════════════════════════════════════════════════════════════

describe("signRequest — outgoing header trio", () => {
  test("emits exactly x-maw-from / x-maw-signed-at / x-maw-signature", () => {
    const h = signRequest({
      from: FROM,
      peerKey: PEER_KEY,
      method: "POST",
      path: "/api/send",
      body: JSON.stringify({ target: "white:neo", text: "hi" }),
    });
    expect(Object.keys(h).sort()).toEqual(["x-maw-from", "x-maw-signature", "x-maw-signed-at"]);
    expect(h["x-maw-from"]).toBe(FROM);
    expect(h["x-maw-signature"]).toMatch(/^[0-9a-f]{64}$/);
    // ISO 8601 UTC — Date#toISOString shape, e.g. 2026-04-28T10:11:12.345Z
    expect(h["x-maw-signed-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("payload is `<from>\\n<signedAt>\\n<METHOD>\\n<path>\\n<bodyHashHex>` (verifier-aligned)", () => {
    const body = JSON.stringify({ target: "white:neo", text: "hi" });
    const h = signRequest({
      from: FROM,
      peerKey: PEER_KEY,
      method: "post", // input lowercased — implementation should uppercase
      path: "/api/send",
      body,
    });
    const expected = createHmac("sha256", PEER_KEY)
      .update(`${FROM}\n${h["x-maw-signed-at"]}\nPOST\n/api/send\n${hashBody(body)}`)
      .digest("hex");
    expect(h["x-maw-signature"]).toBe(expected);
  });

  test("body-less requests use empty bodyHash (not a hash of empty string)", () => {
    const h = signRequest({
      from: FROM,
      peerKey: PEER_KEY,
      method: "GET",
      path: "/api/sessions",
    });
    const expected = createHmac("sha256", PEER_KEY)
      .update(`${FROM}\n${h["x-maw-signed-at"]}\nGET\n/api/sessions\n`)
      .digest("hex");
    expect(h["x-maw-signature"]).toBe(expected);
  });

  test("body-swap → different signature (body bound, replay attack closed)", () => {
    const sigA = signRequest({
      from: FROM, peerKey: PEER_KEY, method: "POST", path: "/api/send",
      body: JSON.stringify({ text: "original" }),
    })["x-maw-signature"];
    const sigB = signRequest({
      from: FROM, peerKey: PEER_KEY, method: "POST", path: "/api/send",
      body: JSON.stringify({ text: "swapped" }),
    })["x-maw-signature"];
    expect(sigA).not.toBe(sigB);
  });

  test("missing from / peerKey → throws (callers must not silently skip)", () => {
    expect(() => signRequest({ from: "", peerKey: PEER_KEY, method: "GET", path: "/x" })).toThrow();
    expect(() => signRequest({ from: FROM, peerKey: "", method: "GET", path: "/x" })).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveFromAddress — precedence ladder
// ════════════════════════════════════════════════════════════════════════════

describe("resolveFromAddress — <oracle>:<node> derivation", () => {
  const origAgent = process.env.CLAUDE_AGENT_NAME;
  afterEach(() => {
    if (origAgent === undefined) delete process.env.CLAUDE_AGENT_NAME;
    else process.env.CLAUDE_AGENT_NAME = origAgent;
  });

  test("CLAUDE_AGENT_NAME wins (no shell-out, no node lookup beyond config)", () => {
    process.env.CLAUDE_AGENT_NAME = "scribe";
    expect(resolveFromAddress("white")).toBe("scribe:white");
  });

  test("no node configured → null (caller skips signing in single-node posture)", () => {
    process.env.CLAUDE_AGENT_NAME = "scribe";
    expect(resolveFromAddress(undefined)).toBeNull();
    expect(resolveFromAddress(null)).toBeNull();
    expect(resolveFromAddress("")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// curlFetch + from — end-to-end against a real Bun.serve
// ════════════════════════════════════════════════════════════════════════════

describe("curlFetch with `from` — outgoing wire format", () => {
  test("from: explicit string → headers reach the peer with valid HMAC", async () => {
    configStore = { node: "white" };
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
      const res = await curlFetch(url, {
        method: "POST",
        body,
        from: FROM,
      });
      expect(res.ok).toBe(true);
      expect(captured["x-maw-from"]).toBe(FROM);
      expect(captured["x-maw-signature"]).toMatch(/^[0-9a-f]{64}$/);
      expect(captured["x-maw-signed-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Verify HMAC matches the body the peer received.
      const expected = createHmac("sha256", PEER_KEY)
        .update(`${FROM}\n${captured["x-maw-signed-at"]}\nPOST\n/api/send\n${hashBody(body)}`)
        .digest("hex");
      expect(captured["x-maw-signature"]).toBe(expected);
    } finally {
      server.stop(true);
    }
  });

  test('from: "auto" + config.node → derives from CLAUDE_AGENT_NAME:<node>', async () => {
    process.env.CLAUDE_AGENT_NAME = "scribe";
    configStore = { node: "white" };
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
      const res = await curlFetch(url, { method: "POST", body: "{}", from: "auto" });
      expect(res.ok).toBe(true);
      expect(captured["x-maw-from"]).toBe("scribe:white");
    } finally {
      delete process.env.CLAUDE_AGENT_NAME;
      server.stop(true);
    }
  });

  test('from: "auto" with no node configured → silently skips from-signing (no x-maw-from header)', async () => {
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
      const url = `http://127.0.0.1:${server.port}/api/sessions`;
      const res = await curlFetch(url, { from: "auto" });
      expect(res.ok).toBe(true);
      expect(captured["x-maw-from"]).toBeUndefined();
      expect(captured["x-maw-signature"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("no `from` option → headers are not sent (legacy callers unaffected)", async () => {
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
      const url = `http://127.0.0.1:${server.port}/api/sessions`;
      await curlFetch(url);
      expect(captured["x-maw-from"]).toBeUndefined();
      expect(captured["x-maw-signed-at"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
