/**
 * Tests for POST /api/peer/exec — the HTTP transport prototype for
 * the /wormhole protocol. Companion to src/api/peer-exec.ts.
 *
 * PROTOTYPE — iteration 4 of the federation-join-easy /loop. Drafted on the
 * feat/wormhole-http-endpoint-draft branch. See
 * mawui-oracle/ψ/writing/federation-join-easy.md for full context.
 *
 * These tests follow the bud-root.test.ts + contacts.test.ts conventions:
 * pure-function tests for the trust-boundary helpers, and in-process Elysia
 * app.handle() tests for the POST route with a stubbed peer backend.
 *
 * The iteration-3 prototype is honest v0.1-over-HTTP: one JSON blob per
 * response, regex signature parse, no request IDs. Iteration 4+ protocol
 * refinements (request IDs, streaming, Zod, typed verbs) are tracked in the
 * proof doc but not tested here — they belong to the v0.2 PR.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import {
  parseSignature,
  isReadOnlyCmd,
  isShellPeerAllowed,
  resolvePeerUrl,
  relayToPeer,
  createPeerExecApi,
  emitWormholeLifecycle,
} from "../src/api/peer-exec";
import type { FeedEvent } from "../src/lib/feed";
import type { WormholeLifecycleInput } from "../src/lib/wormhole-events";

// ---- Pure helper tests ---------------------------------------------------

describe("parseSignature", () => {
  test("parses [host:agent] into structured fields", () => {
    const r = parseSignature("[oracle-world:mawjs-oracle]");
    expect(r).toEqual({
      originHost: "oracle-world",
      originAgent: "mawjs-oracle",
      isAnon: false,
    });
  });

  test("flags anon-* agents", () => {
    const r = parseSignature("[local.buildwithoracle.com:anon-a1b2c3d4]");
    expect(r).not.toBeNull();
    expect(r!.isAnon).toBe(true);
    expect(r!.originAgent).toBe("anon-a1b2c3d4");
  });

  test("returns null for malformed signatures (missing brackets)", () => {
    expect(parseSignature("oracle-world:mawjs-oracle")).toBeNull();
  });

  test("returns null for malformed signatures (missing colon)", () => {
    expect(parseSignature("[oracle-world-mawjs-oracle]")).toBeNull();
  });

  test("returns null for empty signature", () => {
    expect(parseSignature("")).toBeNull();
  });

  test("accepts hostnames with dots and hyphens (real-world shapes)", () => {
    const r = parseSignature("[local.buildwithoracle.com:anon-12345678]");
    expect(r?.originHost).toBe("local.buildwithoracle.com");
    expect(r?.isAnon).toBe(true);
  });

  test("agent name containing dashes is preserved (not just the anon- prefix)", () => {
    const r = parseSignature("[white:white-wormhole-oracle]");
    expect(r?.originAgent).toBe("white-wormhole-oracle");
    expect(r?.isAnon).toBe(false);
  });
});

describe("isReadOnlyCmd", () => {
  test.each([
    "/dig",
    "/dig --all 5",
    "/trace",
    "/trace --deep",
    "/recap",
    "/recap --now",
    "/standup",
    "/who-are-you",
    "/philosophy",
    "/where-we-are",
  ])("permits %s", (cmd) => {
    expect(isReadOnlyCmd(cmd)).toBe(true);
  });

  test.each([
    "/awaken",
    "/commit",
    "/rrr",
    "/incubate laris-co/foo",
    "/diggy --deep", // starts with /dig but not the /dig verb
    "rm -rf /",
    "",
    "dig", // no leading slash
  ])("denies %s", (cmd) => {
    expect(isReadOnlyCmd(cmd)).toBe(false);
  });

  test("guards against prefix-only matches (e.g. /digit is not /dig)", () => {
    // Our whitelist uses exact match OR "prefix + ' '" so /digit should fail.
    expect(isReadOnlyCmd("/digit --flag")).toBe(false);
  });

  test("trims leading/trailing whitespace before matching", () => {
    expect(isReadOnlyCmd("  /dig --all 5  ")).toBe(true);
  });
});

describe("isShellPeerAllowed", () => {
  // Note: this test reads the real config via loadConfig(). The anon-* branch
  // is deterministic regardless of config state, so we only test that path.

  test("anon-* is ALWAYS denied regardless of config", () => {
    expect(isShellPeerAllowed("anon-a1b2c3d4")).toBe(false);
    expect(isShellPeerAllowed("anon-00000000")).toBe(false);
  });

  test("unknown origin is denied (no config.wormhole.shellPeers entry)", () => {
    expect(isShellPeerAllowed("some-random-host-xyz-does-not-exist", {
      loadConfig: () => ({ wormhole: { shellPeers: [] } }) as any,
    })).toBe(false);
  });
});

describe("resolvePeerUrl", () => {
  const noNamedPeers = { loadConfig: () => ({ namedPeers: [] }) as any };

  test("resolves a bare host:port to http://host:port", () => {
    expect(resolvePeerUrl("10.20.0.7:3456", noNamedPeers)).toBe("http://10.20.0.7:3456");
    expect(resolvePeerUrl("localhost:3457", noNamedPeers)).toBe("http://localhost:3457");
  });

  test("returns a full http:// URL unchanged", () => {
    expect(resolvePeerUrl("http://oracle-world.example:3456", noNamedPeers)).toBe(
      "http://oracle-world.example:3456",
    );
  });

  test("returns a full https:// URL unchanged", () => {
    expect(resolvePeerUrl("https://local.buildwithoracle.com", noNamedPeers)).toBe(
      "https://local.buildwithoracle.com",
    );
  });

  test("returns null for an unknown bare peer name", () => {
    expect(resolvePeerUrl("ghost-peer-xyz", noNamedPeers)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(resolvePeerUrl("", noNamedPeers)).toBeNull();
  });
});

describe("relayToPeer", () => {
  test("posts JSON, signs when a federation token exists, and reports elapsed time", async () => {
    const requests: any[] = [];
    const ticks = [100, 137];

    const result = await relayToPeer(
      "http://peer.local:3456",
      { cmd: "/dig", args: ["--deep"], signature: "[local:oracle]" },
      {
        loadConfig: () => ({ federationToken: "secret" }) as any,
        signHeaders: (token, method, path) => ({
          "x-signed": `${token}:${method}:${path}`,
        }),
        now: () => ticks.shift() ?? 137,
        fetch: (async (url, init) => {
          requests.push({ url, init });
          return new Response("accepted", { status: 202 });
        }) as typeof fetch,
      },
    );

    expect(result).toEqual({
      output: "accepted",
      from: "http://peer.local:3456",
      elapsedMs: 37,
      status: 202,
    });
    expect(requests).toEqual([
      {
        url: "http://peer.local:3456/api/peer/exec",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-signed": "secret:POST:/api/peer/exec",
          },
          body: JSON.stringify({
            cmd: "/dig",
            args: ["--deep"],
            signature: "[local:oracle]",
          }),
        },
      },
    ]);
  });

  test("omits signing headers when no federation token exists", async () => {
    const requests: any[] = [];

    const result = await relayToPeer(
      "http://peer.local:3456",
      { cmd: "/recap", args: [], signature: "[local:anon]" },
      {
        loadConfig: () => ({}) as any,
        fetch: (async (url, init) => {
          requests.push({ url, init });
          return new Response("readonly", { status: 200 });
        }) as typeof fetch,
      },
    );

    expect(result.output).toBe("readonly");
    expect(requests[0].init.headers).toEqual({ "Content-Type": "application/json" });
    expect(typeof result.elapsedMs).toBe("number");
  });
});

// ---- In-process POST route tests ----------------------------------------

// Mount peerExecApi on an Elysia app so we can call it with app.handle().
// This avoids booting the full server and keeps the tests deterministic.

function makeApp(deps: Parameters<typeof createPeerExecApi>[0] = {}) {
  return new Elysia({ prefix: "/api" })
    .onError(({ code, set }) => {
      if (code === "PARSE") {
        set.status = 400;
        return { error: "invalid_body" };
      }
    })
    .use(createPeerExecApi({
      isShellPeerAllowed: () => false,
      resolvePeerUrl: () => null,
      ...deps,
    }));
}

// Force production mode so the cookie check is active (dev bypass off).
// We use beforeEach/afterEach to scope this to the POST tests only.
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
});
afterEach(() => {
  process.env.NODE_ENV = savedEnv;
});

describe("GET /api/peer/session", () => {
  test("issues a pe_session cookie", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/peer/session"));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    expect(cookie!).toMatch(/pe_session=[a-f0-9]+/);
    expect(cookie!).toContain("HttpOnly");
    expect(cookie!).toContain("SameSite=Strict");
  });

  test("returns ok + rotation policy", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/peer/session"));
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.rotates).toBe("on_server_restart");
  });
});

describe("POST /api/peer/exec (trust flow)", () => {
  async function sessionCookie(app: ReturnType<typeof makeApp>): Promise<string> {
    const res = await app.handle(new Request("http://localhost/api/peer/session"));
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/pe_session=([a-f0-9]+)/);
    if (!match) throw new Error("no session cookie issued");
    return `pe_session=${match[1]}`;
  }

  test("400 on missing fields (no peer)", async () => {
    const app = makeApp();
    const cookie = await sessionCookie(app);
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ cmd: "/dig", signature: "[local:anon-1]" }),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("missing_fields");
  });

  test("400 on bad signature shape", async () => {
    const app = makeApp();
    const cookie = await sessionCookie(app);
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ peer: "white", cmd: "/dig", signature: "not-a-signature" }),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("bad_signature");
  });

  test("401 when session cookie is missing (production mode)", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("no_session");
  });

  test("403 when anon-* origin tries a non-readonly cmd", async () => {
    const app = makeApp();
    const cookie = await sessionCookie(app);
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "white",
        cmd: "/awaken",
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("shell_peer_denied");
    expect(body.hint).toContain("anonymous browser visitors are read-only");
  });

  test("404 on unknown peer name (readonly cmd that passes trust check)", async () => {
    const app = makeApp();
    const cookie = await sessionCookie(app);
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        peer: "ghost-peer-xyz",
        cmd: "/dig",
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("unknown_peer");
  });

  test("allowlisted shell peers relay with shell trust tier", async () => {
    const relayCalls: any[] = [];
    const app = new Elysia({ prefix: "/api" }).use(createPeerExecApi({
      hasValidSessionCookie: () => true,
      parseSignature: () => ({ originHost: "trusted-host", originAgent: "operator", isAnon: false }),
      isReadOnlyCmd: () => false,
      isShellPeerAllowed: (origin) => origin === "trusted-host",
      resolvePeerUrl: () => "http://peer.local:3456",
      relayToPeer: (async (peerUrl, body) => {
        relayCalls.push({ peerUrl, body });
        return { output: "done", from: peerUrl, elapsedMs: 9, status: 201 };
      }) as typeof relayToPeer,
    }));

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "peer",
        cmd: "/awaken",
        args: ["--fast"],
        signature: "[trusted-host:operator]",
      }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      output: "done",
      from: "http://peer.local:3456",
      elapsed_ms: 9,
      status: 201,
      trust_tier: "shell_allowlisted",
    });
    expect(relayCalls).toEqual([{
      peerUrl: "http://peer.local:3456",
      body: { cmd: "/awaken", args: ["--fast"], signature: "[trusted-host:operator]" },
    }]);
  });

  test("relay failures surface as 502", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createPeerExecApi({
      hasValidSessionCookie: () => true,
      parseSignature: () => ({ originHost: "local", originAgent: "anon", isAnon: true }),
      isReadOnlyCmd: () => true,
      resolvePeerUrl: () => "http://peer.local:3456",
      relayToPeer: (async () => { throw new Error("peer offline"); }) as typeof relayToPeer,
    }));

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({ peer: "peer", cmd: "/dig", signature: "[local:anon]" }),
    }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "relay_failed",
      peer: "http://peer.local:3456",
      reason: "peer offline",
    });
  });

  test("invalid JSON body → 400 invalid_body", async () => {
    const app = makeApp();
    const cookie = await sessionCookie(app);
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "not-json-{",
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_body");
  });

  test("dev mode (NODE_ENV !== production) skips the session cookie check", async () => {
    // Flip to development for this one test
    process.env.NODE_ENV = "development";
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no cookie
      body: JSON.stringify({
        peer: "ghost-peer-xyz", // unknown so we still get a reject, but further down the stack
        cmd: "/dig",
        signature: "[local:anon-a1b2c3d4]",
      }),
    }));
    // Should NOT be 401 (cookie bypassed), should be 404 (unknown peer)
    expect(res.status).toBe(404);
  });
});

describe("trust boundary — anon-* can only run readonly cmds", () => {
  // This is the load-bearing invariant: no matter what the config says,
  // an anon-* origin never gets shell access. We test all 7 readonly cmds
  // pass the trust check and a handful of non-readonly cmds fail.

  const READONLY_CMDS = [
    "/dig",
    "/trace",
    "/recap",
    "/standup",
    "/who-are-you",
    "/philosophy",
    "/where-we-are",
  ];

  const NON_READONLY_CMDS = ["/awaken", "/commit", "/rrr", "/oracle install"];

  test.each(READONLY_CMDS)("anon-* permitted to run %s (trust check passes)", (cmd) => {
    expect(isReadOnlyCmd(cmd)).toBe(true);
    expect(isShellPeerAllowed("anon-a1b2c3d4")).toBe(false);
    // Together: readonly = true short-circuits the allowlist check, so permitted.
  });

  test.each(NON_READONLY_CMDS)("anon-* DENIED from running %s", (cmd) => {
    expect(isReadOnlyCmd(cmd)).toBe(false);
    expect(isShellPeerAllowed("anon-a1b2c3d4")).toBe(false);
    // Together: readonly = false AND allowlist = false, so denied.
  });
});

// ---- WormholeRequest / WormholeFail feed events --------------------------
//
// peer-exec.ts emits typed wormhole lifecycle events through the plugin
// feed bus (mirroring MessageSend/MessageDeliver/MessageFail). The fail
// events are gated behind a successful signature parse — malformed
// requests do NOT produce events.

describe("wormhole feed lifecycle emission", () => {
  type EmittedEvent = Parameters<NonNullable<Parameters<typeof createPeerExecApi>[0]>["emitWormholeLifecycle"] & Function>[0];

  function makeAppWith(opts: {
    overrides?: Parameters<typeof createPeerExecApi>[0];
    relay?: typeof relayToPeer;
  } = {}) {
    const events: EmittedEvent[] = [];
    const app = new Elysia({ prefix: "/api" }).use(createPeerExecApi({
      hasValidSessionCookie: () => true,
      parseSignature: () => ({ originHost: "white", originAgent: "white-wormhole", isAnon: false }),
      isReadOnlyCmd: () => true,
      isShellPeerAllowed: () => true,
      resolvePeerUrl: () => "http://peer.local:3456",
      relayToPeer: opts.relay ?? ((async () => ({ output: "ok", from: "peer", elapsedMs: 5, status: 200 })) as typeof relayToPeer),
      emitWormholeLifecycle: (input) => { events.push(input); },
      ...(opts.overrides ?? {}),
    }));
    return { app, events };
  }

  test("relay success emits WormholeRequest delivered with trust_tier + UTF-8 outputBytes", async () => {
    const output = "ไทย";
    const { app, events } = makeAppWith({
      relay: (async () => ({
        output,
        from: "http://peer.local:3456",
        elapsedMs: 42,
        status: 200,
      })) as typeof relayToPeer,
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        args: ["--deep"],
        signature: "[white:white-wormhole]",
      }),
    }));

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "relayed",
      state: "delivered",
      cmd: "/dig",
      args: ["--deep"],
      origin: "[white:white-wormhole]",
      peer: "white",
      peerUrl: "http://peer.local:3456",
      trustTier: "readonly",
      elapsedMs: 42,
      status: 200,
      outputBytes: new TextEncoder().encode(output).byteLength,
    });
  });

  test("peer HTTP failures emit WormholeFail while preserving relay response semantics", async () => {
    const { app, events } = makeAppWith({
      relay: (async () => ({
        output: "boom",
        from: "http://peer.local:3456",
        elapsedMs: 19,
        status: 500,
      })) as typeof relayToPeer,
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        args: ["--deep"],
        signature: "[white:white-wormhole]",
      }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      output: "boom",
      from: "http://peer.local:3456",
      elapsed_ms: 19,
      status: 500,
      trust_tier: "readonly",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      direction: "relayed",
      state: "failed",
      status: 500,
      error: "peer_status_500",
      peer: "white",
      peerUrl: "http://peer.local:3456",
      trustTier: "readonly",
    });
  });

  test("default lifecycle path builds and pushes feed events", async () => {
    const pushed: FeedEvent[] = [];
    const built: WormholeLifecycleInput[] = [];
    const app = new Elysia({ prefix: "/api" }).use(createPeerExecApi({
      hasValidSessionCookie: () => true,
      parseSignature: () => ({ originHost: "white", originAgent: "white-wormhole", isAnon: false }),
      isReadOnlyCmd: () => true,
      isShellPeerAllowed: () => true,
      resolvePeerUrl: () => "http://peer.local:3456",
      relayToPeer: (async () => ({
        output: "ok",
        from: "http://peer.local:3456",
        elapsedMs: 7,
        status: 204,
      })) as typeof relayToPeer,
      buildWormholeLifecycleFeedEvent: (input) => {
        built.push(input);
        return {
          timestamp: "2026-05-20T12:00:00.000Z",
          oracle: "white-wormhole",
          host: "white",
          event: input.state === "failed" ? "WormholeFail" : "WormholeRequest",
          project: "",
          sessionId: input.peer,
          message: `${input.direction}/${input.state} ${input.cmd}`,
          ts: 1_769_000_000_000,
          data: { id: "built", ts: "2026-05-20T12:00:00.000Z", ...input },
        } as FeedEvent;
      },
      pushFeedEvent: (event) => { pushed.push(event); },
    }));

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        args: ["--deep"],
        signature: "[white:white-wormhole]",
      }),
    }));

    expect(res.status).toBe(200);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({
      direction: "relayed",
      state: "delivered",
      cmd: "/dig",
      args: ["--deep"],
      origin: "[white:white-wormhole]",
      peer: "white",
      peerUrl: "http://peer.local:3456",
      trustTier: "readonly",
      elapsedMs: 7,
      status: 204,
      outputBytes: 2,
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      event: "WormholeRequest",
      sessionId: "white",
    });
  });

  test("emitWormholeLifecycle swallows build and push failures", () => {
    const input: WormholeLifecycleInput = {
      direction: "relayed",
      state: "delivered",
      cmd: "/dig",
      args: [],
      origin: "[white:white-wormhole]",
      peer: "white",
      trustTier: "readonly",
    };

    expect(() => emitWormholeLifecycle(input, {
      buildWormholeLifecycleFeedEvent: () => {
        throw new Error("builder broke");
      },
    })).not.toThrow();

    expect(() => emitWormholeLifecycle(input, {
      pushFeedEvent: () => {
        throw new Error("listener broke");
      },
    })).not.toThrow();
  });

  test("missing session cookie emits WormholeFail with status=401", async () => {
    // Force production so cookie check runs
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const { app, events } = makeAppWith({
      overrides: { hasValidSessionCookie: () => false },
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        signature: "[white:white-wormhole]",
      }),
    }));

    process.env.NODE_ENV = savedEnv;

    expect(res.status).toBe(401);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "failed",
      status: 401,
      trustTier: "denied",
      error: "no_session",
      origin: "[white:white-wormhole]",
      peer: "white",
    });
  });

  test("shell_peer_denied emits WormholeFail with status=403 trustTier=denied", async () => {
    const { app, events } = makeAppWith({
      overrides: {
        isReadOnlyCmd: () => false,
        isShellPeerAllowed: () => false,
        parseSignature: () => ({ originHost: "unknown-host", originAgent: "stranger", isAnon: false }),
      },
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/awaken",
        signature: "[unknown-host:stranger]",
      }),
    }));

    expect(res.status).toBe(403);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "failed",
      status: 403,
      trustTier: "denied",
      error: "shell_peer_denied",
      origin: "[unknown-host:stranger]",
    });
  });

  test("unknown_peer emits WormholeFail with status=404", async () => {
    const { app, events } = makeAppWith({
      overrides: { resolvePeerUrl: () => null },
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "ghost-peer",
        cmd: "/dig",
        signature: "[white:white-wormhole]",
      }),
    }));

    expect(res.status).toBe(404);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "failed",
      status: 404,
      trustTier: "readonly",
      error: "unknown_peer",
      peer: "ghost-peer",
    });
  });

  test("relay throw emits WormholeFail with status=502 and the underlying message", async () => {
    const { app, events } = makeAppWith({
      relay: (async () => { throw new Error("peer offline"); }) as typeof relayToPeer,
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        signature: "[white:white-wormhole]",
      }),
    }));

    expect(res.status).toBe(502);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "failed",
      status: 502,
      error: "peer offline",
      peer: "white",
      peerUrl: "http://peer.local:3456",
    });
  });

  test("bad_signature (400) does NOT emit (no parsed origin available)", async () => {
    const { app, events } = makeAppWith({
      overrides: { parseSignature: () => null },
    });

    const res = await app.handle(new Request("http://localhost/api/peer/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "pe_session=fake" },
      body: JSON.stringify({
        peer: "white",
        cmd: "/dig",
        signature: "not-bracketed",
      }),
    }));

    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});
