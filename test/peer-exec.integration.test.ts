/**
 * Integration tests for POST /api/peer/exec — exercises the FULL
 * signed-relay path through a mocked-fetch stub peer instead of just the
 * helper functions in isolation.
 *
 * PROTOTYPE — iteration 9 (convergence iteration) of the federation-join-easy
 * /loop. Drafted on feat/wormhole-http-endpoint-draft. Companion to
 * test/peer-exec.test.ts (which covers the helpers + route 400/401/403/404
 * paths in-process). See mawui-oracle/ψ/writing/federation-join-easy.md.
 *
 * ## Strategy
 *
 * The peer-exec route's `relayToPeer()` calls `fetch(peerUrl + "/api/peer/exec")`
 * to forward signed requests to a peer. We can't easily run a second
 * full hono server in the test runner, so instead we replace
 * `globalThis.fetch` with a router that dispatches to a stub peer hono
 * app via its own `app.request()` method. This gives us:
 *
 *   - Real peer-exec route execution (in-process via app.request())
 *   - Real signed outbound construction (relayToPeer calls signHeaders)
 *   - Stub peer that records what it received and returns canned responses
 *   - Round-trip assertions on body, headers, status, elapsed_ms
 *
 * The stub peer is intentionally simple — it doesn't run federation-auth
 * verification because we're testing the peer-exec route, not the auth
 * middleware (which has its own coverage). The stub just records the
 * request and returns whatever the test specifies.
 *
 * ## What this catches that the unit tests miss
 *
 * The unit tests in test/peer-exec.test.ts cover the route's pre-relay
 * paths (validation, trust boundary, peer resolution). They short-circuit
 * before the actual relay because all peers in those tests are unknown.
 * This integration test exercises the bytes that go OUT to the peer and
 * the bytes that come BACK — the part the unit tests deliberately don't
 * touch.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { peerExecApi } from "../src/api/peer-exec";

// ---- Stub peer infrastructure --------------------------------------------

interface PeerCapture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function buildStubPeerApp(
  capture: PeerCapture[],
  responseBuilder: (req: PeerCapture) => Response,
): Hono {
  const app = new Hono();
  app.post("/api/peer/exec", async (c) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await c.req.text();
    const cap: PeerCapture = {
      url: c.req.url,
      method: c.req.method,
      headers,
      body,
    };
    capture.push(cap);
    return responseBuilder(cap);
  });
  return app;
}

// ---- App-under-test ------------------------------------------------------

function makeMawApp(): Hono {
  const app = new Hono();
  const apiSub = new Hono();
  apiSub.route("/", peerExecApi);
  app.route("/api", apiSub);
  return app;
}

// ---- fetch mock router ---------------------------------------------------

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Default to dev mode so the session-cookie check doesn't get in the way
  // — we test the cookie path explicitly in the unit tests.
  process.env.NODE_ENV = "development";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NODE_ENV;
});

function installPeerRouter(stubPeerUrl: string, stubApp: Hono) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(stubPeerUrl)) {
      // Strip the peer base and dispatch to the stub app
      const path = url.slice(stubPeerUrl.length) || "/";
      return stubApp.request(path, {
        method: init?.method || "GET",
        headers: init?.headers as any,
        body: init?.body as any,
      });
    }
    // Anything else falls through to the real fetch (unlikely in tests)
    return originalFetch(input, init);
  }) as typeof fetch;
}

// ---- Helpers -------------------------------------------------------------

function makePeerExecBody(overrides: Partial<{
  peer: string;
  cmd: string;
  args: string[];
  signature: string;
}> = {}) {
  return JSON.stringify({
    peer: "stub-peer-test:9999",
    cmd: "/dig",
    args: ["--all", "5"],
    signature: "[mawui-test:anon-deadbeef]",
    ...overrides,
  });
}

// ---- Tests ---------------------------------------------------------------

describe("peer-exec integration — happy path", () => {
  test("relays a signed request to the peer and returns the response verbatim", async () => {
    const captures: PeerCapture[] = [];
    const stubPeerUrl = "http://stub-peer-test:9999";
    const stubApp = buildStubPeerApp(captures, () =>
      new Response("dig output from stub peer", { status: 200 }),
    );
    installPeerRouter(stubPeerUrl, stubApp);

    const app = makeMawApp();
    const res = await app.request("/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: makePeerExecBody(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // The peer's response body comes back verbatim in the `output` field
    expect(body.output).toBe("dig output from stub peer");
    // The peer URL is reported in `from`
    expect(body.from).toBe(stubPeerUrl);
    // Trust tier was readonly because /dig is in the whitelist
    expect(body.trust_tier).toBe("readonly");
    // elapsed_ms is a positive number
    expect(typeof body.elapsed_ms).toBe("number");
    expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
    // Status from the peer
    expect(body.status).toBe(200);
  });

  test("the peer received exactly one POST with the forwarded body", async () => {
    const captures: PeerCapture[] = [];
    const stubPeerUrl = "http://stub-peer-test:9999";
    const stubApp = buildStubPeerApp(captures, () =>
      new Response("ok", { status: 200 }),
    );
    installPeerRouter(stubPeerUrl, stubApp);

    const app = makeMawApp();
    await app.request("/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: makePeerExecBody({ cmd: "/trace", args: ["--deep"] }),
    });

    expect(captures.length).toBe(1);
    const cap = captures[0];
    expect(cap.method).toBe("POST");
    // The relay forwards the original body envelope verbatim — the peer
    // sees the same {peer, cmd, args, signature} shape that the browser
    // sent us. (This is a deliberate design choice: the peer is itself
    // a wormhole node and re-applies its own trust boundary.)
    const peerBody = JSON.parse(cap.body);
    expect(peerBody.cmd).toBe("/trace");
    expect(peerBody.args).toEqual(["--deep"]);
    expect(peerBody.signature).toBe("[mawui-test:anon-deadbeef]");
  });
});

describe("peer-exec integration — peer error paths", () => {
  test("peer returns 500 → we return 200 with peer's status in body", async () => {
    // Note: we return 200 from our route even when the peer errored.
    // The peer's status is in the body's `status` field for the caller
    // to inspect. This matches the unit tests' expectation that relay
    // succeeds whenever the upstream call completes — only network-level
    // failures cascade as 502 relay_failed.
    const captures: PeerCapture[] = [];
    const stubPeerUrl = "http://stub-peer-test:9999";
    const stubApp = buildStubPeerApp(captures, () =>
      new Response("internal error from peer", { status: 500 }),
    );
    installPeerRouter(stubPeerUrl, stubApp);

    const app = makeMawApp();
    const res = await app.request("/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: makePeerExecBody(),
    });

    expect(res.status).toBe(200); // OUR route succeeded
    const body = (await res.json()) as any;
    expect(body.status).toBe(500); // The peer's status
    expect(body.output).toBe("internal error from peer");
  });

  test("network failure → we return 502 relay_failed", async () => {
    // Replace fetch with one that throws — simulates DNS failure / TCP reset
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const app = makeMawApp();
    const res = await app.request("/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: makePeerExecBody({ peer: "http://will-not-resolve.invalid:1234" }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error).toBe("relay_failed");
    expect(body.reason).toContain("ECONNREFUSED");
  });
});

describe("peer-exec integration — body round-trip", () => {
  test("large response bodies round-trip cleanly", async () => {
    // Locks the v0.1-over-HTTP "one JSON blob per response" behavior.
    // Iteration 4+'s v0.2 protocol will replace this with chunked
    // streaming; this test documents the v0.1 limit.
    const captures: PeerCapture[] = [];
    const stubPeerUrl = "http://stub-peer-test:9999";
    const bigBody = "X".repeat(50000); // 50KB
    const stubApp = buildStubPeerApp(captures, () =>
      new Response(bigBody, { status: 200 }),
    );
    installPeerRouter(stubPeerUrl, stubApp);

    const app = makeMawApp();
    const res = await app.request("/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: makePeerExecBody(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.output.length).toBe(50000);
    expect(body.output).toBe(bigBody);
  });

  test("UTF-8 bodies (Thai script) round-trip cleanly", async () => {
    // Federation oracles use Thai phrases throughout. The relay must
    // not corrupt unicode anywhere in the round-trip.
    const captures: PeerCapture[] = [];
    const stubPeerUrl = "http://stub-peer-test:9999";
    const thaiBody = "บำเพ็ญเพียร 👁 mesh ไม่มีหน้า จนกว่า Mawui จะวาดให้";
    const stubApp = buildStubPeerApp(captures, () =>
      new Response(thaiBody, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
    installPeerRouter(stubPeerUrl, stubApp);

    const app = makeMawApp();
    const res = await app.request("/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: makePeerExecBody(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.output).toBe(thaiBody);
  });
});
