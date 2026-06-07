/**
 * Extra runtime branch coverage for src/lib/federation-auth.ts.
 *
 * Ownership: this isolated file only. It avoids duplicating the broad crypto
 * assertions in federation-auth.test.ts and instead drives edge/error branches
 * that are hard to reach from normal request fixtures.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { createHmac } from "crypto";
import { join } from "path";
import { Hono } from "hono";
import type { MawConfig } from "../../src/config";

const realConfig = await import("../../src/config");
const realLoadConfig = realConfig.loadConfig;

let mockActive = false;
let configStore: Partial<MawConfig> = {};

mock.module(join(import.meta.dir, "../../src/config"), () => ({
  ...realConfig,
  loadConfig: (...args: unknown[]) => mockActive
    ? (configStore as MawConfig)
    : (realLoadConfig as (...a: unknown[]) => MawConfig)(...args),
}));

const {
  buildFromSignPayload,
  DEFAULT_ORACLE,
  federationAuth,
  hashBody,
  resolveFromAddress,
  sign,
  signHeaders,
  signRequestV3,
  signHeadersV3,
  verifyRequest,
} = await import("../../src/lib/federation-auth");

const TOKEN = "0123456789abcdef-federation-token";
const FROM = "mawjs:white";
const PEER_KEY = "feedface".repeat(8);

const originalWarn = console.warn;
let warns: string[] = [];

beforeEach(() => {
  mockActive = true;
  configStore = { federationToken: TOKEN };
  warns = [];
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
});

afterEach(() => {
  mockActive = false;
  console.warn = originalWarn;
});

afterAll(() => {
  mockActive = false;
  console.warn = originalWarn;
});

function makeApp() {
  const app = new Hono();
  app.use("*", federationAuth());
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

async function fire(path: string, init: RequestInit = {}, clientIp = "203.0.113.7"): Promise<Response> {
  const env = { server: { requestIP: () => ({ address: clientIp }) } };
  return makeApp().fetch(new Request(`http://host${path}`, init), env);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("federationAuth protected runtime branches", () => {
  test.each([
    "/api/pane-keys",
    "/api/talk",
    "/api/transport/send",
    "/api/worktrees/cleanup",
  ])("%s is protected for remote callers without HMAC", async (path) => {
    const res = await fire(path, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "federation auth required",
      reason: "missing_signature",
    });
  });

  test("uppercase V2 auth version hashes the cloned request body and accepts valid HMAC", async () => {
    const body = JSON.stringify({ target: "m5", text: "body-bound" });
    const ts = Math.floor(Date.now() / 1000);
    const res = await fire("/api/talk", {
      method: "POST",
      body,
      headers: {
        "x-maw-auth-version": "V2",
        "x-maw-signature": sign(TOKEN, "POST", "/api/talk", ts, hashBody(body)),
        "x-maw-timestamp": String(ts),
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("v2 body read failure returns body_read_failed instead of throwing", async () => {
    const handler = federationAuth() as unknown as (c: any, next: () => Promise<void>) => Promise<Response | void>;
    const ts = Math.floor(Date.now() / 1000);
    const response = await handler({
      env: { server: { requestIP: () => ({ address: "203.0.113.8" }) } },
      req: {
        method: "POST",
        url: "http://host/api/send",
        raw: { clone: () => { throw new Error("synthetic clone failure"); } },
        header: (name: string) => ({
          "x-maw-auth-version": "v2",
          "x-maw-signature": sign(TOKEN, "POST", "/api/send", ts, hashBody("body")),
          "x-maw-timestamp": String(ts),
        } as Record<string, string>)[name.toLowerCase()],
      },
      json: (body: unknown, status: number) => Response.json(body, { status }),
    }, async () => { throw new Error("next should not run"); });

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({
      error: "federation auth failed",
      reason: "body_read_failed",
    });
    expect(warns.join("\n")).toContain("synthetic clone failure");
  });
});

describe("verifyRequest current-v3 malformed and edge branches", () => {
  test("cached v3 request with malformed unix timestamp refuses as invalid-timestamp", () => {
    const decision = verifyRequest({
      method: "POST",
      path: "/api/send",
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature-v3": "0".repeat(64),
        "x-maw-timestamp": "not-unix-seconds",
      },
      body: "",
      lookupPubkey: (from) => (from === FROM ? PEER_KEY : undefined),
      now: 1_700_000_000,
    });

    expect(decision).toEqual({ kind: "refuse-malformed", reason: "invalid-timestamp" });
  });

  test("cached v3 request with unsafe integer timestamp refuses as invalid-timestamp", () => {
    const decision = verifyRequest({
      method: "POST",
      path: "/api/send",
      headers: {
        "x-maw-from": FROM,
        "x-maw-signature-v3": "0".repeat(64),
        "x-maw-timestamp": String(Number.MAX_SAFE_INTEGER + 1),
      },
      body: "",
      lookupPubkey: () => PEER_KEY,
      now: 1_700_000_000,
    });

    expect(decision).toEqual({ kind: "refuse-malformed", reason: "invalid-timestamp" });
  });

  test("cached v3 request beyond the shared 300s window refuses with delta", () => {
    const now = 1_700_000_000;
    const stale = now - 301;
    const headers = signHeadersV3({
      peerKey: PEER_KEY,
      fromAddress: FROM,
      method: "POST",
      path: "/api/send",
      timestamp: stale,
      body: "",
    });

    const decision = verifyRequest({
      method: "POST",
      path: "/api/send",
      headers,
      body: "",
      lookupPubkey: () => PEER_KEY,
      now,
    });

    expect(decision).toEqual({
      kind: "refuse-skew",
      reason: "timestamp-out-of-window",
      from: FROM,
      delta: 301,
    });
  });

  test("Headers-compatible objects pass through as case-insensitive v3 input", () => {
    const timestamp = 1_700_000_000;
    const body = new TextEncoder().encode(JSON.stringify({ text: "typed-array body" }));
    const payload = buildFromSignPayload(FROM, timestamp, "post", "/api/send", hashBody(body));
    const headers = new Headers({
      "X-Maw-From": FROM,
      "X-Maw-Signature-V3": hmacHex(PEER_KEY, payload),
      "X-Maw-Timestamp": String(timestamp),
    });

    const decision = verifyRequest({
      method: "post",
      path: "/api/send",
      headers,
      body,
      lookupPubkey: () => PEER_KEY,
      now: timestamp,
    });

    expect(decision).toEqual({ kind: "accept-verified", reason: "cache-sig-valid", from: FROM });
  });
});

describe("federation auth helper edge branches", () => {
  test("signHeaders treats empty bodies as legacy v1 and non-empty typed bodies as v2", () => {
    const empty = signHeaders(TOKEN, "POST", "/api/send", new Uint8Array());
    expect(empty["X-Maw-Auth-Version"]).toBeUndefined();

    const body = new TextEncoder().encode("hello");
    const signed = signHeaders(TOKEN, "POST", "/api/send", body);
    const timestamp = Number(signed["X-Maw-Timestamp"]);
    expect(signed["X-Maw-Auth-Version"]).toBe("v2");
    expect(signed["X-Maw-Signature"]).toBe(sign(TOKEN, "POST", "/api/send", timestamp, hashBody(body)));
  });

  test("signRequestV3 validates required peer key and from-address before signing", () => {
    expect(() => signRequestV3({
      peerKey: "",
      fromAddress: FROM,
      method: "POST",
      path: "/api/send",
      timestamp: 1,
    })).toThrow("peerKey is required");
    expect(() => signRequestV3({
      peerKey: PEER_KEY,
      fromAddress: "",
      method: "POST",
      path: "/api/send",
      timestamp: 1,
    })).toThrow("fromAddress is required");
  });

  test("resolveFromAddress uses mawjs fallback oracle and returns null without node", () => {
    expect(DEFAULT_ORACLE).toBe("mawjs");
    expect(resolveFromAddress({ node: "white" })).toBe("mawjs:white");
    expect(resolveFromAddress({ oracle: "pulse", node: "m5" })).toBe("pulse:m5");
    expect(resolveFromAddress({ oracle: "pulse" })).toBeNull();
  });
});
