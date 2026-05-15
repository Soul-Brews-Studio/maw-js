/**
 * elysia-auth-global-scope.test.ts — regression for maw-stress findings #1 + #3.
 *
 * #1 (CRITICAL) — `federationAuth` was a bare `new Elysia(...).onBeforeHandle(...)`
 *   with no `.as('global')`. In Elysia 1.4 a named plugin's lifecycle hook is
 *   `local`-scoped: it guards only routes defined on that same instance.
 *   `federationAuth` defines ZERO routes, so the hook guarded nothing — every
 *   protected write endpoint (`/api/send`, …) accepted unsigned non-loopback
 *   requests. maw-stress revalidation confirmed this empirically.
 *   Fix: `.as('global')` so the hook propagates to sibling route modules.
 *
 * #3 (HIGH) — `federationAuth` did `if (!token) return;` at the top — fail-OPEN.
 *   A node with peers configured binds 0.0.0.0 and is network-reachable, so
 *   "no token" there is default-insecure-open. Fix: fail-closed — no token +
 *   peers configured + !allowPeersWithoutToken ⇒ 401.
 *
 * Isolated: mocks `src/config` (mock.module is process-global) and mutates
 * the bun-server reference via setBunServer.
 */
import { describe, test, expect, mock, beforeAll, afterEach } from "bun:test";
import { join } from "path";
import { Elysia } from "elysia";
import type { MawConfig } from "../../src/config";

const root = join(import.meta.dir, "../..");

// Mutable config state — the auth hook calls loadConfig() fresh per request,
// so each test can dial in the federation posture it needs.
const TOKEN = "test-federation-token-min-16-chars";
let configState: Partial<MawConfig> = { node: "test-node", federationToken: TOKEN };

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => configState);
});

let federationAuth: typeof import("../../src/lib/elysia-auth").federationAuth;
let setBunServer: typeof import("../../src/lib/elysia-auth").setBunServer;
let sign: typeof import("../../src/lib/federation-auth").sign;

const NON_LOOPBACK_IP = "168.144.97.69";

/** Mount federationAuth + a protected route as SEPARATE plugin instances —
 *  this mirrors src/api/index.ts (`.use(federationAuth).use(sessionsApi)`)
 *  and is exactly the topology the `.as('global')` fix has to cover. */
function buildApp(): Elysia {
  const protectedRoutes = new Elysia()
    .post("/send", () => ({ ok: true }))
    .get("/sessions", () => ({ ok: true }));
  return new Elysia({ prefix: "/api" }).use(federationAuth).use(protectedRoutes);
}

/** Point setBunServer at a fake server reporting the given client IP. */
function setClientIp(address: string): void {
  setBunServer({ requestIP: () => ({ address }) } as unknown as import("bun").Server);
}

beforeAll(async () => {
  const mod = await import("../../src/lib/elysia-auth");
  federationAuth = mod.federationAuth;
  setBunServer = mod.setBunServer;
  sign = (await import("../../src/lib/federation-auth")).sign;
});

afterEach(() => {
  configState = { node: "test-node", federationToken: TOKEN };
});

describe("federationAuth — global scope (#1)", () => {
  test("REGRESSION: unsigned non-loopback POST /api/send → 401 (hook must guard sibling routes)", async () => {
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "x", text: "y" }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("missing_signature");
  });

  test("signed non-loopback POST /api/send → reaches handler (200)", async () => {
    setClientIp(NON_LOOPBACK_IP);
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TOKEN, "POST", "/api/send", ts);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-maw-signature": sig,
          "x-maw-timestamp": String(ts),
        },
        body: JSON.stringify({ target: "x", text: "y" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("loopback unsigned POST /api/send → bypass (local CLI exemption preserved)", async () => {
    setClientIp("127.0.0.1");
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
  });

  test("non-protected GET /api/sessions → public even unsigned from non-loopback", async () => {
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/sessions", { method: "GET" }),
    );
    expect(res.status).toBe(200);
  });

  test("bad signature non-loopback → 401 (hook actually inspects the sig)", async () => {
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: {
          "x-maw-signature": "deadbeef".repeat(8),
          "x-maw-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("federationAuth — fail-closed when peers configured but no token (#3)", () => {
  test("REGRESSION: no token + peers configured + non-loopback → 401 (was fail-open)", async () => {
    configState = { node: "test-node", peers: ["http://peer-a.example"] };
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("federation_token_required");
  });

  test("no token + namedPeers configured + non-loopback → 401", async () => {
    configState = {
      node: "test-node",
      namedPeers: [{ name: "peer-a", url: "http://peer-a.example" }],
    };
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  test("no token + peers + allowPeersWithoutToken:true → explicit opt-in bypass", async () => {
    configState = {
      node: "test-node",
      peers: ["http://peer-a.example"],
      allowPeersWithoutToken: true,
    };
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
  });

  test("no token + NO peers + non-loopback → pass (single-node backwards compat)", async () => {
    configState = { node: "test-node" };
    setClientIp(NON_LOOPBACK_IP);
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
  });

  test("no token + peers + loopback → pass (fail-closed only gates non-loopback)", async () => {
    configState = { node: "test-node", peers: ["http://peer-a.example"] };
    setClientIp("127.0.0.1");
    const res = await buildApp().handle(
      new Request("http://localhost/api/send", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
  });
});
