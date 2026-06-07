/**
 * elysia-auth-extra-coverage.test.ts
 *
 * Extra isolated branch coverage for src/lib/elysia-auth.ts.  This file owns
 * only in-process Elysia harnesses plus module seams for config/peers so the
 * auth hooks can be driven deterministically without touching real config.
 */
import { describe, test, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { join } from "path";
import { Elysia, t } from "elysia";
import type { MawConfig } from "../../src/config";

const root = join(import.meta.dir, "../..");
const TOKEN = "test-federation-token-min-16-chars";
const NON_LOOPBACK_IP = "203.0.113.44";
const PEER_SECRET = "peer-secret-min-16-chars";

let configState: Partial<MawConfig> = { node: "local", federationToken: TOKEN };
let peersState: Record<string, { node?: string; pubkey?: string }> = {};

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => configState);
});

mock.module(join(root, "src/lib/peers/store"), () => ({
  loadPeers: () => ({ peers: peersState }),
}));

let federationAuth: typeof import("../../src/lib/elysia-auth").federationAuth;
let fromSigningAuth: typeof import("../../src/lib/elysia-auth").fromSigningAuth;
let isProtected: typeof import("../../src/lib/elysia-auth").isProtected;
let lookupCachedPubkey: typeof import("../../src/lib/elysia-auth").lookupCachedPubkey;
let setBunServer: typeof import("../../src/lib/elysia-auth").setBunServer;
let sign: typeof import("../../src/lib/federation-auth").sign;
let hashBody: typeof import("../../src/lib/federation-auth").hashBody;
let buildFromSignPayload: typeof import("../../src/lib/federation-auth").buildFromSignPayload;

function setClientIp(address: string): void {
  setBunServer({ requestIP: () => ({ address }) } as unknown as import("bun").Server);
}

function hmacApp(): Elysia {
  return new Elysia({ prefix: "/api" })
    .use(federationAuth)
    .post("/send", () => ({ ok: true, route: "send" }))
    .get("/plugin/download/:name", () => ({ ok: true, route: "download" }))
    .post("/plugins/:name", () => ({ ok: true, route: "plugin" }));
}

function fromAuthApp(): Elysia {
  return new Elysia({ prefix: "/api" })
    .use(fromSigningAuth)
    .post("/send", () => ({ ok: true, route: "send" }))
    .get("/sessions", () => ({ ok: true, route: "sessions" }));
}

function fullAuthPaneKeysApp(): Elysia {
  return new Elysia({ prefix: "/api" })
    .use(federationAuth)
    .use(fromSigningAuth)
    .post(
      "/pane-keys",
      ({ body }) => ({ ok: true, route: "pane-keys", target: body.target, enter: body.enter }),
      { body: t.Object({ target: t.String(), text: t.String(), enter: t.Optional(t.Boolean()) }) },
    );
}

function signedHeaders(method: string, path: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    "x-maw-timestamp": String(timestamp),
    "x-maw-signature": sign(TOKEN, method, path, timestamp),
  };
}

function fromSignatureHeaders(opts: {
  from?: string;
  timestamp?: number;
  method?: string;
  path?: string;
  body?: string;
  secret?: string;
  signature?: string;
} = {}): Record<string, string> {
  const from = opts.from ?? "oracle:peer-node";
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const method = opts.method ?? "POST";
  const path = opts.path ?? "/api/send";
  const bodyHash = hashBody(opts.body ?? "");
  const payload = buildFromSignPayload(from, timestamp, method, path, bodyHash);
  const signature = opts.signature ?? createHmac("sha256", opts.secret ?? PEER_SECRET).update(payload).digest("hex");
  return {
    "x-maw-from": from,
    "x-maw-timestamp": String(timestamp),
    "x-maw-signature-v3": signature,
    "x-maw-auth-version": "v3",
  };
}

beforeAll(async () => {
  const elysiaAuth = await import("../../src/lib/elysia-auth");
  federationAuth = elysiaAuth.federationAuth;
  fromSigningAuth = elysiaAuth.fromSigningAuth;
  isProtected = elysiaAuth.isProtected;
  lookupCachedPubkey = elysiaAuth.lookupCachedPubkey;
  setBunServer = elysiaAuth.setBunServer;

  const federation = await import("../../src/lib/federation-auth");
  sign = federation.sign;
  hashBody = federation.hashBody;
  buildFromSignPayload = federation.buildFromSignPayload;
});

beforeEach(() => {
  configState = { node: "local", federationToken: TOKEN };
  peersState = {};
  setClientIp(NON_LOOPBACK_IP);
});

afterEach(() => {
  configState = { node: "local", federationToken: TOKEN };
  peersState = {};
});

describe("isProtected — route classification extras", () => {
  test("POST /plugins/:name and GET /plugin/download/:artifact are protected", () => {
    expect(isProtected("/plugins/demo", "POST")).toBe(true);
    expect(isProtected("/plugin/download/demo.tgz", "GET")).toBe(true);
  });

  test("safe plugin discovery/read shapes stay public", () => {
    expect(isProtected("/plugins/demo", "GET")).toBe(false);
    expect(isProtected("/plugin/list-manifest/demo", "GET")).toBe(false);
  });
});

describe("lookupCachedPubkey — peers store edge cases", () => {
  test("returns the first pubkey whose peer node matches the from-address node", () => {
    peersState = {
      noKey: { node: "peer-node" },
      match: { node: "peer-node", pubkey: PEER_SECRET },
      other: { node: "other-node", pubkey: "other-secret" },
    };

    expect(lookupCachedPubkey("oracle:peer-node")).toBe(PEER_SECRET);
  });

  test("malformed or unmatched from-addresses return undefined", () => {
    peersState = { match: { node: "peer-node", pubkey: PEER_SECRET } };

    expect(lookupCachedPubkey("missing-colon")).toBeUndefined();
    expect(lookupCachedPubkey("oracle:   ")).toBeUndefined();
    expect(lookupCachedPubkey("oracle:unknown-node")).toBeUndefined();
  });
});

describe("federationAuth — HMAC success and error branches", () => {
  test("invalid timestamp on protected non-loopback request → 401 invalid_timestamp", async () => {
    const res = await hmacApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: { "x-maw-signature": "0".repeat(64), "x-maw-timestamp": "not-a-number" },
      body: "{}",
    }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "federation auth failed", reason: "invalid_timestamp" });
  });

  test("expired but otherwise well-formed signature → 401 timestamp_expired with delta", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 1_000;
    const res = await hmacApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: signedHeaders("POST", "/api/send", oldTs),
      body: "{}",
    }));

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("timestamp_expired");
    expect(typeof body.delta).toBe("number");
    expect(body.delta as number).toBeGreaterThan(300);
  });

  test("signed GET /api/plugin/download/:artifact reaches handler", async () => {
    const res = await hmacApp().handle(new Request("http://localhost/api/plugin/download/demo.tgz", {
      method: "GET",
      headers: signedHeaders("GET", "/api/plugin/download/demo.tgz"),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "download" });
  });

  test("x-maw-from lets HMAC layer defer instead of rejecting the from-signature slot", async () => {
    const res = await hmacApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: { "x-maw-from": "oracle:peer-node", "x-maw-signature": "not-a-fleet-hmac" },
      body: "{}",
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "send" });
  });
});

describe("fromSigningAuth — per-peer continuity branches", () => {
  test("no federationToken configured → protected request passes through", async () => {
    configState = { node: "local" };

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", { method: "POST", body: "{}" }));

    expect(res.status).toBe(200);
  });

  test("unprotected route stays public even with cached peer state", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };

    const res = await fromAuthApp().handle(new Request("http://localhost/api/sessions", { method: "GET" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "sessions" });
  });

  test("loopback protected request bypasses from-signing", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };
    setClientIp("127.0.0.1");

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", { method: "POST", body: "{}" }));

    expect(res.status).toBe(200);
  });

  test("protected HMAC requests without x-maw-from skip the from-signing body reader (#1859)", async () => {
    const body = new ReadableStream({
      pull() {
        throw new Error("body should not be read by from-signing");
      },
    });

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      body,
      // Bun follows the Fetch streaming-body shape used by Node-compatible runtimes.
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "send" });
  });

  test("/api/pane-keys accepts current v3 from-signing headers even with fleet-HMAC signature noise (#1859)", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };
    const body = JSON.stringify({ target: "origin_discord:0", text: "test", enter: true });

    const res = await fullAuthPaneKeysApp().handle(new Request("http://localhost/api/pane-keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-maw-signature": "0".repeat(64),
        ...fromSignatureHeaders({ path: "/api/pane-keys", body }),
      },
      body,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "pane-keys", target: "origin_discord:0", enter: true });
  });

  test("signed unknown peer accepts TOFU-record path", async () => {
    const body = JSON.stringify({ hello: "tofu" });
    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: fromSignatureHeaders({ body }),
      body,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "send" });
  });

  test("cached peer with valid from-signature reaches handler", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };
    const body = JSON.stringify({ hello: "verified" });

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: fromSignatureHeaders({ body }),
      body,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "send" });
  });

  test.each([
    ["text/plain", "plain-body"],
    ["application/x-www-form-urlencoded", "alpha=one&beta=two"],
    ["application/octet-stream", "raw-bytes"],
  ])("cached peer accepts signed %s bodies captured by onParse", async (contentType, body) => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...fromSignatureHeaders({ body }),
      },
      body,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, route: "send" });
  });

  test("typed protected routes verify from-signing against raw JSON bytes before Elysia body parsing (#1790)", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };
    const body = JSON.stringify({ target: "0", task: "hello" });
    const app = new Elysia({ prefix: "/api" })
      .use(fromSigningAuth)
      .post(
        "/wake",
        ({ body }) => ({ ok: true, target: body.target, task: body.task }),
        { body: t.Object({ target: t.String(), task: t.Optional(t.String()) }) },
      );

    const res = await app.handle(new Request("http://localhost/api/wake", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...fromSignatureHeaders({ path: "/api/wake", body }),
      },
      body,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, target: "0", task: "hello" });
  });

  test("cached peer with invalid from-signature → 401 includes kind/reason/from", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };
    const body = JSON.stringify({ hello: "bad sig" });

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: fromSignatureHeaders({ body, signature: "0".repeat(64) }),
      body,
    }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: "from-signing failed",
      kind: "refuse-mismatch",
      reason: "signature-invalid",
      from: "oracle:peer-node",
    });
  });

  test("cached peer with stale from-signature → 401 includes skew delta", async () => {
    peersState = { peer: { node: "peer-node", pubkey: PEER_SECRET } };
    const body = JSON.stringify({ hello: "old sig" });
    const timestamp = Math.floor((Date.now() - 1_000_000) / 1000);

    const res = await fromAuthApp().handle(new Request("http://localhost/api/send", {
      method: "POST",
      headers: fromSignatureHeaders({ body, timestamp }),
      body,
    }));

    expect(res.status).toBe(401);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      error: "from-signing failed",
      kind: "refuse-skew",
      reason: "timestamp-out-of-window",
      from: "oracle:peer-node",
    });
    expect(payload.delta as number).toBeGreaterThan(300);
  });
});
