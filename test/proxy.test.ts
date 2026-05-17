/**
 * Tests for POST /api/proxy — the generic HTTP proxy for HTTPS origin →
 * HTTP-LAN peer REST calls. Companion to src/api/proxy.ts.
 *
 * PROTOTYPE — iteration 6 of the federation-join-easy /loop. Drafted on
 * feat/api-proxy-http-peers. See
 * mawui-oracle/ψ/writing/federation-join-easy.md for full context.
 *
 * Follows wormhole.test.ts conventions: pure-function tests for helpers,
 * in-process Elysia app.handle() tests for the route, beforeEach/afterEach
 * to toggle NODE_ENV for session-cookie checks.
 *
 * The load-bearing invariant locked here is that GET/HEAD/OPTIONS are
 * always permitted for anonymous browser visitors (mirroring HTTP read-only
 * semantics) while POST/PUT/PATCH/DELETE require the origin to be in
 * `config.proxy.shellPeers`. The path allowlist adds a second layer of
 * defense in depth.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import {
  parseProxySignature,
  isReadOnlyMethod,
  isKnownMethod,
  isPathProxyable,
  isProxyShellPeerAllowed,
  resolveProxyPeerUrl,
  proxyApi,
} from "../src/api/proxy";
import { relayHttpToPeer } from "../src/api/proxy-relay";

// ---- Pure helper tests ---------------------------------------------------

describe("parseProxySignature", () => {
  test("parses [host:agent] into structured fields", () => {
    const r = parseProxySignature("[oracle-world:mawjs-oracle]");
    expect(r).toEqual({
      originHost: "oracle-world",
      originAgent: "mawjs-oracle",
      isAnon: false,
    });
  });

  test("flags anon-* agents", () => {
    const r = parseProxySignature("[local.example.com:anon-a1b2c3d4]");
    expect(r?.isAnon).toBe(true);
  });

  test("returns null for malformed signatures", () => {
    expect(parseProxySignature("not-a-signature")).toBeNull();
    expect(parseProxySignature("[no-colon]")).toBeNull();
    expect(parseProxySignature("")).toBeNull();
  });
});

describe("isReadOnlyMethod", () => {
  test.each(["GET", "HEAD", "OPTIONS"])("%s is readonly", (method) => {
    expect(isReadOnlyMethod(method)).toBe(true);
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])("%s is NOT readonly", (method) => {
    expect(isReadOnlyMethod(method)).toBe(false);
  });

  test("case-insensitive", () => {
    expect(isReadOnlyMethod("get")).toBe(true);
    expect(isReadOnlyMethod("Post")).toBe(false);
  });
});

describe("isKnownMethod", () => {
  test.each(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
    "%s is known",
    (method) => {
      expect(isKnownMethod(method)).toBe(true);
    },
  );

  test.each(["TRACE", "CONNECT", "LINK", "FOOBAR", ""])("%s is unknown", (method) => {
    expect(isKnownMethod(method)).toBe(false);
  });
});

describe("isPathProxyable", () => {
  test.each([
    "/api/config",
    "/api/fleet-config",
    "/api/feed",
    "/api/plugins",
    "/api/federation/status",
    "/api/sessions",
    "/api/worktrees",
    "/api/teams",
    "/api/ping",
  ])("allowlisted path: %s", (path) => {
    expect(isPathProxyable(path)).toBe(true);
  });

  test("allowlisted path with query string", () => {
    expect(isPathProxyable("/api/feed?limit=100")).toBe(true);
  });

  test("sub-paths are NOT proxyable (exact match only, no prefix smuggling)", () => {
    // Load-bearing: if we allowed prefix matching, "/api/worktrees/cleanup"
    // would match "/api/worktrees" and an anonymous visitor could reach a
    // PROTECTED write endpoint via GET. Exact-match enforcement closes this.
    // Caught by the "/api/worktrees/cleanup" case below during iteration-6.
    expect(isPathProxyable("/api/sessions/abc123")).toBe(false);
    expect(isPathProxyable("/api/config/reset")).toBe(false);
  });

  test.each([
    "/api/action",
    "/api/send",
    "/api/talk",
    "/api/transport/send",
    "/api/triggers/fire",
    "/api/worktrees/cleanup",
    "/api/feedback",
    "/etc/passwd",
    "/",
    "",
  ])("denied path: %s", (path) => {
    expect(isPathProxyable(path)).toBe(false);
  });

  test("prevents prefix smuggling — /api/feedback is NOT /api/feed", () => {
    // Load-bearing: the allowlist check must require either exact match OR
    // a path + "/" prefix, not a bare string prefix. Otherwise "/api/feedback"
    // would match "/api/feed".
    expect(isPathProxyable("/api/feedback")).toBe(false);
  });
});

describe("isProxyShellPeerAllowed", () => {
  test("anon-* is ALWAYS denied", () => {
    expect(isProxyShellPeerAllowed("anon-a1b2c3d4")).toBe(false);
    expect(isProxyShellPeerAllowed("anon-00000000")).toBe(false);
  });

  test("unknown origin is denied by default", () => {
    expect(isProxyShellPeerAllowed("some-random-unknown-origin")).toBe(false);
  });

  test("proxy shellPeers is NOT the same config key as wormhole shellPeers", () => {
    // This test documents the separation: adding to config.wormhole.shellPeers
    // does NOT affect config.proxy.shellPeers. The two endpoints have
    // independent trust configs. Verified by reading the source — both
    // functions read different config paths.
    //
    // If this test ever starts failing because both keys were merged,
    // that's a regression of the iteration-5 architectural refinement.
    expect(isProxyShellPeerAllowed.toString()).toContain("proxy?.shellPeers");
  });
});

describe("resolveProxyPeerUrl", () => {
  test("namedPeers config maps bare peer names to URLs", () => {
    expect(resolveProxyPeerUrl("codex", {
      namedPeers: [{ name: "codex", url: "http://codex.local:3456" }],
    })).toBe("http://codex.local:3456");
  });

  test("bare host:port → http://", () => {
    expect(resolveProxyPeerUrl("10.20.0.7:3456")).toBe("http://10.20.0.7:3456");
  });

  test("full http:// URL preserved", () => {
    expect(resolveProxyPeerUrl("http://oracle-world:3456")).toBe("http://oracle-world:3456");
  });

  test("full https:// URL preserved", () => {
    expect(resolveProxyPeerUrl("https://white.local:3456")).toBe("https://white.local:3456");
  });

  test("unknown bare peer name returns null", () => {
    expect(resolveProxyPeerUrl("ghost-peer-abcxyz")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(resolveProxyPeerUrl("")).toBeNull();
  });
});

describe("relayHttpToPeer", () => {
  test("signs mutating requests, forwards JSON bodies, and keeps safe response headers", async () => {
    const requests: any[] = [];
    const ticks = [100, 125];
    const result = await relayHttpToPeer(
      "http://peer.local:3456",
      "post",
      "/api/config",
      "{\"ok\":true}",
      {
        loadConfig: () => ({ federationToken: "secret" }) as any,
        signHeaders: (token, method, path) => ({
          "x-sig-token": `${token}:${method}:${path}`,
        }),
        now: () => ticks.shift() ?? 125,
        fetch: (async (url, init) => {
          requests.push({ url, init });
          return new Response("accepted", {
            status: 202,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              etag: "\"abc\"",
              "last-modified": "Sun, 17 May 2026 00:00:00 GMT",
              "set-cookie": "secret=leak",
            },
          });
        }) as any,
      },
    );

    expect(result).toEqual({
      status: 202,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        etag: "\"abc\"",
        "last-modified": "Sun, 17 May 2026 00:00:00 GMT",
      },
      body: "accepted",
      elapsedMs: 25,
    });
    expect(requests).toEqual([{
      url: "http://peer.local:3456/api/config",
      init: {
        method: "POST",
        headers: {
          "x-sig-token": "secret:POST:/api/config",
          "Content-Type": "application/json",
        },
        body: "{\"ok\":true}",
      },
    }]);
  });

  test("omits readonly request bodies and content-type when relaying GET", async () => {
    const requests: any[] = [];
    const result = await relayHttpToPeer(
      "http://peer.local:3456",
      "GET",
      "/api/config",
      "{\"ignored\":true}",
      {
        loadConfig: () => ({}) as any,
        fetch: (async (url, init) => {
          requests.push({ url, init });
          return new Response("config", { status: 200 });
        }) as any,
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("config");
    expect(requests).toEqual([{
      url: "http://peer.local:3456/api/config",
      init: { method: "GET", headers: {}, body: undefined },
    }]);
  });
});

// ---- In-process POST route tests ----------------------------------------

function makeApp() {
  return new Elysia({ prefix: "/api" })
    .onError(({ code, set }) => {
      if (code === "PARSE") {
        set.status = 400;
        return { error: "invalid_body" };
      }
    })
    .use(proxyApi);
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
});
afterEach(() => {
  process.env.NODE_ENV = savedEnv;
});

describe("GET /api/proxy/session", () => {
  test("issues a proxy_session cookie", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/proxy/session"));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toMatch(/proxy_session=[a-f0-9]+/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("proxy cookie name is distinct from wormhole cookie name", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/proxy/session"));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("proxy_session=");
    expect(cookie).not.toContain("wh_session=");
  });
});

describe("POST /api/proxy (trust flow)", () => {
  async function proxyCookie(app: ReturnType<typeof makeApp>): Promise<string> {
    const res = await app.handle(new Request("http://localhost/api/proxy/session"));
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/proxy_session=([a-f0-9]+)/);
    if (!match) throw new Error("no proxy session cookie issued");
    return `proxy_session=${match[1]}`;
  }

  test("400 on missing fields", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ peer: "white", method: "GET", signature: "[local:anon-1]" }),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("missing_fields");
  });

  test("400 when the parsed body is absent or not an object", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "null",
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  test("400 on bad signature", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "white",
        method: "GET",
        path: "/api/config",
        signature: "not-a-signature",
      }),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("bad_signature");
  });

  test("400 on unknown method", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "white",
        method: "TRACE",
        path: "/api/config",
        signature: "[local:anon-1]",
      }),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("unknown_method");
  });

  test("401 when session cookie is missing in production mode", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer: "white",
        method: "GET",
        path: "/api/config",
        signature: "[local:anon-1]",
      }),
    }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("no_session");
  });

  test("403 when anon-* tries a mutation (POST)", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "white",
        method: "POST",
        path: "/api/ping",
        body: "{}",
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("mutation_denied");
    expect(body.hint).toContain("anonymous browser visitors can only GET");
  });

  test("403 mutation denial explains allowlisting for named non-allowlisted origins", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "white",
        method: "POST",
        path: "/api/ping",
        body: "{}",
        signature: "[local:operator]",
      }),
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      error: "mutation_denied",
      origin: "local",
      method: "POST",
      hint: "add this origin to config.proxy.shellPeers to permit mutations",
    });
  });

  test("403 on non-allowlisted path (even GET)", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "white",
        method: "GET",
        path: "/api/action", // not in allowlist
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("path_not_proxyable");
  });

  test("404 on unknown peer", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "ghost-peer-abcxyz",
        method: "GET",
        path: "/api/config",
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("unknown_peer");
  });

  test("dev mode bypasses the session cookie check", async () => {
    process.env.NODE_ENV = "development";
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer: "ghost-peer-abcxyz",
        method: "GET",
        path: "/api/config",
        signature: "[local:anon-1]",
      }),
    }));
    // Should NOT be 401 (cookie bypassed) — should be 404 (unknown peer)
    expect(res.status).toBe(404);
  });

  test("dev mode relays readonly requests to explicit peer URLs", async () => {
    process.env.NODE_ENV = "development";
    const oldFetch = globalThis.fetch;
    const requests: any[] = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url, init });
      return new Response("{\"remote\":true}", {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "nope" },
      });
    }) as any;
    try {
      const app = makeApp();
      const res = await app.handle(new Request("http://localhost/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peer: "http://peer.local:3456",
          method: "GET",
          path: "/api/config",
          signature: "[local:anon-1]",
        }),
      }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({
        status: 200,
        headers: { "content-type": "application/json" },
        body: "{\"remote\":true}",
        from: "http://peer.local:3456",
        trust_tier: "readonly_method",
      });
      expect(typeof body.elapsed_ms).toBe("number");
      expect(requests[0]).toMatchObject({
        url: "http://peer.local:3456/api/config",
        init: { method: "GET", body: undefined },
      });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("relay failures surface as 502 with peer URL and reason", async () => {
    process.env.NODE_ENV = "development";
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as any;
    try {
      const app = makeApp();
      const res = await app.handle(new Request("http://localhost/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peer: "http://peer.local:3456",
          method: "GET",
          path: "/api/config",
          signature: "[local:anon-1]",
        }),
      }));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "relay_failed",
        peer: "http://peer.local:3456",
        reason: "connection refused",
      });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("invalid JSON → 400 invalid_body", async () => {
    const app = makeApp();
    const cookie = await proxyCookie(app);
    const res = await app.handle(new Request("http://localhost/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "not-json-{",
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_body");
  });
});

describe("trust boundary — anon-* method semantics (load-bearing)", () => {
  // Load-bearing invariant: anonymous browser visitors can GET anything in
  // the path allowlist, but cannot POST/PUT/PATCH/DELETE regardless of path.

  test("anon-* + GET + allowlisted path → permitted at the method+trust layer", () => {
    expect(isReadOnlyMethod("GET")).toBe(true);
    // GET is readonly, so the mutation_denied check is short-circuited.
    // The actual 403/404 depends on path allowlist + peer resolution
    // (tested in the POST route tests above).
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "anon-* + %s → denied by mutation_denied",
    (method) => {
      expect(isReadOnlyMethod(method)).toBe(false);
      expect(isProxyShellPeerAllowed("anon-a1b2c3d4")).toBe(false);
      // Together: readonly=false AND allowlist=false → mutation_denied
    },
  );

  test("GET on the entire path allowlist is always method-permitted", () => {
    const allowed = [
      "/api/config",
      "/api/fleet-config",
      "/api/feed",
      "/api/plugins",
      "/api/federation/status",
      "/api/sessions",
      "/api/worktrees",
      "/api/teams",
      "/api/ping",
    ];
    for (const path of allowed) {
      expect(isPathProxyable(path)).toBe(true);
      // Method GET is readonly; path is allowlisted → permitted flow.
    }
  });
});
