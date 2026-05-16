import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { DiscoveredPeer } from "../../src/transports/scout-state";
import {
  createPeerDiscoveriesApi,
  toDiscoveryResponse,
} from "../../src/api/peers-discoveries";

const NOW = Date.parse("2026-05-16T00:00:00.000Z");

function peer(overrides: Partial<DiscoveredPeer>): DiscoveredPeer {
  return {
    zid: "zid-a",
    node: "m5",
    host: "m5.local",
    oracle: "mawjs",
    locators: ["http://m5:3456"],
    capabilities: ["pair", "send"],
    oracles: ["mawjs-oracle"],
    lastSeen: NOW - 5_000,
    paired: false,
    ...overrides,
  };
}

describe("peer discoveries API (#1526)", () => {
  test("filters paired peers by default and formats discovery rows", () => {
    const resp = toDiscoveryResponse([
      peer({ zid: "paired", node: "paired-node", paired: true }),
      peer({ zid: "fresh", node: "fresh-node", lastSeen: NOW - 65_000 }),
    ], { now: NOW });

    expect(resp).toMatchObject({
      ok: true,
      total: 1,
      shown: 1,
      filtered: true,
    });
    expect(resp.peers[0]).toMatchObject({
      zid: "fresh",
      node: "fresh-node",
      seenRel: "1m",
      paired: false,
    });
  });

  test("GET /api/peers/discoveries supports --all and --limit shape", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createPeerDiscoveriesApi(() => [
      peer({ zid: "older", node: "older", lastSeen: NOW - 10_000 }),
      peer({ zid: "newer", node: "newer", lastSeen: NOW - 1_000 }),
    ]));

    const res = await app.handle(new Request("http://local/api/peers/discoveries?all=1&limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total).toBe(2);
    expect(body.shown).toBe(1);
    expect(body.filtered).toBe(false);
    expect(body.peers[0].zid).toBe("newer");
  });

  test("GET /api/peers/discovered aliases the canonical discoveries route", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createPeerDiscoveriesApi(() => [
      peer({ zid: "zenoh-row", node: "zenoh-node", lastSeen: NOW - 1_000 }),
    ]));

    const res = await app.handle(new Request("http://local/api/peers/discovered?all=1"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.peers[0]).toMatchObject({
      zid: "zenoh-row",
      node: "zenoh-node",
    });
  });

  test("GET /api/peers/discoveries rejects invalid limits", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createPeerDiscoveriesApi(() => []));
    const res = await app.handle(new Request("http://local/api/peers/discoveries?limit=wat"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_limit" });
  });
});

describe("peer discoveries CLI client (#1526)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("404 gets an actionable daemon-version hint instead of bare http_404", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const { fetchDiscoveries } = await import("../../src/vendor/mpr-plugins/peers/discovered");
    const resp = await fetchDiscoveries();
    expect(resp).toMatchObject({
      ok: false,
      error: "discovery_endpoint_missing",
      status: 404,
    });
    expect((resp as any).hint).toContain("restart `maw serve`");
  });
});
