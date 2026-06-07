import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const auth = await import("../../src/lib/federation-auth.ts?function-coverage");
const TOKEN = "0123456789abcdef-federation-token";
const PEER_KEY = "feedface".repeat(8);
const FROM = "mawjs:m5";
const originalWarn = console.warn;
let warnings: string[] = [];

beforeEach(() => {
  mockActive = true;
  configStore = { federationToken: TOKEN };
  warnings = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
});

afterEach(() => {
  mockActive = false;
  console.warn = originalWarn;
});

afterAll(() => {
  mockActive = false;
  console.warn = originalWarn;
});

function hmac(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function app() {
  const h = new Hono();
  h.use("*", auth.federationAuth());
  h.all("*", (c) => c.json({ ok: true }));
  return h;
}

async function fire(path: string, init: RequestInit = {}, clientIp: string | undefined = "203.0.113.10") {
  const env = clientIp === undefined
    ? { server: { requestIP: () => undefined } }
    : { server: { requestIP: () => ({ address: clientIp }) } };
  return app().fetch(new Request(`http://host${path}`, init), env);
}

describe("federation-auth function coverage", () => {
  test("hashing and signing helpers cover v1, v2, v3, and validation branches", () => {
    expect(auth.hashBody(null)).toBe("");
    expect(auth.hashBody(undefined)).toBe("");
    expect(auth.hashBody("")).toBe("");
    expect(auth.hashBody(new Uint8Array())).toBe("");
    expect(auth.hashBody("body")).toMatch(/^[0-9a-f]{64}$/);

    const now = Math.floor(Date.now() / 1000);
    const sig = auth.sign(TOKEN, "POST", "/api/send", now);
    expect(auth.verify(TOKEN, "POST", "/api/send", now, sig)).toBe(true);
    expect(auth.verify(TOKEN, "POST", "/api/send", now - 301, sig)).toBe(false);
    expect(auth.verify(TOKEN, "POST", "/api/send", now, "short")).toBe(false);
    expect(auth.verify(TOKEN, "POST", "/api/send", now, "z".repeat(64))).toBe(false);

    expect(auth.isLoopback("127.9.0.1")).toBe(true);
    expect(auth.isLoopback("::1")).toBe(true);
    expect(auth.isLoopback("localhost")).toBe(true);
    expect(auth.isLoopback(undefined)).toBe(false);

    const h1 = auth.signHeaders(TOKEN, "GET", "/api/send");
    expect(h1["X-Maw-Auth-Version"]).toBeUndefined();
    const h2 = auth.signHeaders(TOKEN, "POST", "/api/send", "body");
    expect(h2["X-Maw-Auth-Version"]).toBe("v2");

    expect(() => auth.signRequestV3({ peerKey: "", fromAddress: FROM, method: "POST", path: "/api/send", timestamp: now })).toThrow("peerKey");
    expect(() => auth.signRequestV3({ peerKey: PEER_KEY, fromAddress: "", method: "POST", path: "/api/send", timestamp: now })).toThrow("fromAddress");
    const v3 = auth.signRequestV3({ peerKey: PEER_KEY, fromAddress: FROM, method: "post", path: "/api/send", timestamp: now, body: "body" });
    expect(v3.signature).toBe(hmac(PEER_KEY, auth.buildFromSignPayload(FROM, now, "POST", "/api/send", auth.hashBody("body"))));
    expect(auth.signHeadersV3({ peerKey: PEER_KEY, fromAddress: FROM, method: "POST", path: "/api/send", timestamp: now })["X-Maw-Auth-Version"]).toBe("v3");
    expect(auth.resolveFromAddress({ node: "m5" })).toBe(`${auth.DEFAULT_ORACLE}:m5`);
    expect(auth.resolveFromAddress({ oracle: "pulse" })).toBeNull();
  });

  test("middleware covers protected, pass-through, reject, v1 warning, and v2 body branches", async () => {
    configStore = {};
    expect((await fire("/api/send", { method: "POST" })).status).toBe(200);

    configStore = { peers: [{ name: "white", url: "http://white" }] } as any;
    let res = await fire("/api/send", { method: "POST" });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe("federation_token_required");

    configStore = { federationToken: TOKEN };
    expect((await fire("/api/sessions", { method: "GET" })).status).toBe(200);
    expect((await fire("/api/feed", { method: "GET" })).status).toBe(200);
    expect((await fire("/api/send", { method: "POST" }, "127.0.0.1")).status).toBe(200);

    res = await fire("/api/send", { method: "POST" });
    expect((await res.json()).reason).toBe("missing_signature");
    res = await fire("/api/send", { method: "POST", headers: { "x-maw-signature": "0".repeat(64), "x-maw-timestamp": "bad" } });
    expect((await res.json()).reason).toBe("invalid_timestamp");

    const stale = Math.floor(Date.now() / 1000) - 3600;
    res = await fire("/api/send", { method: "POST", headers: { "x-maw-signature": auth.sign(TOKEN, "POST", "/api/send", stale), "x-maw-timestamp": String(stale) } });
    expect((await res.json()).reason).toBe("timestamp_expired");

    const ts = Math.floor(Date.now() / 1000);
    res = await fire("/api/talk", { method: "POST", headers: { "x-maw-signature": auth.sign(TOKEN, "POST", "/api/talk", ts), "x-maw-timestamp": String(ts) } });
    expect(res.status).toBe(200);
    expect(warnings.join("\n")).toContain("v1 (body-unsigned) accepted");

    const body = JSON.stringify({ ok: true });
    res = await fire("/api/talk", { method: "POST", body, headers: { "x-maw-auth-version": "V2", "x-maw-signature": auth.sign(TOKEN, "POST", "/api/talk", ts, auth.hashBody(body)), "x-maw-timestamp": String(ts) } });
    expect(res.status).toBe(200);
  });

  test("verifyRequest covers O6 decisions, malformed cases, legacy fallback, and refusal guard", () => {
    const now = 1_700_000_000;
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: {}, body: "", lookupPubkey: () => undefined, now })).toEqual({ kind: "accept-legacy", reason: "no-cache-no-sig" });

    const signed = auth.signHeadersV3({ peerKey: PEER_KEY, fromAddress: FROM, method: "POST", path: "/api/send", timestamp: now, body: "body" });
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: signed, body: "body", lookupPubkey: () => undefined, now }).kind).toBe("accept-tofu-record");
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: { "x-maw-from": FROM }, body: "", lookupPubkey: () => PEER_KEY, now })).toEqual({ kind: "refuse-unsigned", reason: "cache-no-sig", from: FROM });
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: signed, body: "body", lookupPubkey: () => PEER_KEY, now }).kind).toBe("accept-verified");
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: signed, body: "tampered", lookupPubkey: () => PEER_KEY, now }).kind).toBe("refuse-mismatch");
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: { ...signed, "X-Maw-Timestamp": String(now - 301) }, body: "body", lookupPubkey: () => PEER_KEY, now }).kind).toBe("refuse-skew");
    expect(auth.verifyRequest({ method: "POST", path: "/api/send", headers: { "x-maw-from": FROM, "x-maw-signature-v3": "0".repeat(64), "x-maw-timestamp": "nope" }, body: "", lookupPubkey: () => PEER_KEY, now })).toEqual({ kind: "refuse-malformed", reason: "invalid-timestamp" });

    const iso = new Date(now * 1000).toISOString();
    const legacyPayload = `${FROM}\n${iso}\nPOST\n/api/send\n${auth.hashBody("body")}`;
    const legacyHeaders = { "x-maw-from": FROM, "x-maw-signature": hmac(PEER_KEY, legacyPayload), "x-maw-signed-at": iso };
    const legacyDecision = auth.verifyRequest({ method: "POST", path: "/api/send", headers: legacyHeaders, body: "body", lookupPubkey: () => PEER_KEY, now });
    expect(legacyDecision.kind).toBe("accept-verified");
    expect(auth.isRefuseDecision(legacyDecision)).toBe(false);
    expect(auth.isRefuseDecision({ kind: "refuse-mismatch", reason: "signature-invalid", from: FROM })).toBe(true);
  });
});
