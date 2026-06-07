import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createPeerDiscoveriesApi,
  toDiscoveryResponse,
} from "../src/api/peers-discoveries";
import type { DiscoveredPeer } from "../src/transports/scout-state";

const NOW = Date.parse("2026-05-16T00:00:00.000Z");

function peer(overrides: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
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

function appWith(peers: DiscoveredPeer[]) {
  return new Elysia({ prefix: "/api" }).use(createPeerDiscoveriesApi(() => peers));
}

describe("peer discoveries API default-suite coverage", () => {
  test("toDiscoveryResponse filters paired rows, sorts by recency then node, and formats relative age", () => {
    const resp = toDiscoveryResponse([
      peer({ zid: "paired", node: "paired-node", paired: true, lastSeen: NOW - 1_000 }),
      peer({ zid: "fresh-b", node: "beta", lastSeen: NOW - 5_000 }),
      peer({ zid: "fresh-a", node: "alpha", lastSeen: NOW - 5_000 }),
    ], { now: NOW, limit: 0 });

    expect(resp).toMatchObject({ ok: true, total: 2, shown: 2, filtered: true });
    expect(resp.peers.map(p => p.zid)).toEqual(["fresh-a", "fresh-b"]);
    expect(resp.peers[0]).toMatchObject({
      node: "alpha",
      oracle: "mawjs",
      host: "m5.local",
      locators: ["http://m5:3456"],
      capabilities: ["pair", "send"],
      oracles: ["mawjs-oracle"],
      firstSeen: new Date(NOW - 5_000).toISOString(),
      lastSeen: new Date(NOW - 5_000).toISOString(),
      seenRel: "5s",
      paired: false,
    });
  });

  test("toDiscoveryResponse can include paired rows and renders minute/hour/day buckets", () => {
    const resp = toDiscoveryResponse([
      peer({ zid: "minutes", node: "minutes", lastSeen: NOW - 65_000 }),
      peer({ zid: "hours", node: "hours", lastSeen: NOW - 2 * 60 * 60 * 1000 }),
      peer({ zid: "days", node: "days", lastSeen: NOW - 3 * 24 * 60 * 60 * 1000, paired: true }),
      peer({ zid: "future", node: "future", lastSeen: NOW + 1_000 }),
    ], { all: true, limit: 4, now: NOW });

    expect(resp).toMatchObject({ total: 4, shown: 4, filtered: false });
    expect(Object.fromEntries(resp.peers.map(p => [p.zid, p.seenRel]))).toEqual({
      future: "0s",
      minutes: "1m",
      hours: "2h",
      days: "3d",
    });
  });

  test("GET /api/peers/discoveries supports all=true and positive limit", async () => {
    const app = appWith([
      peer({ zid: "older", node: "older", lastSeen: NOW - 10_000 }),
      peer({ zid: "newer", node: "newer", lastSeen: NOW - 1_000 }),
    ]);

    const res = await app.handle(new Request("http://local/api/peers/discoveries?all=true&limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, total: 2, shown: 1, filtered: false });
    expect(body.peers[0].zid).toBe("newer");
  });

  test("GET /api/peers/discovered aliases discoveries and rejects invalid limits", async () => {
    const app = appWith([peer({ zid: "zenoh-row", node: "zenoh-node" })]);

    const alias = await app.handle(new Request("http://local/api/peers/discovered?all=1"));
    expect(alias.status).toBe(200);
    expect(await alias.json()).toMatchObject({ peers: [{ zid: "zenoh-row", node: "zenoh-node" }] });

    for (const limit of ["wat", "0", "-1"]) {
      const res = await app.handle(new Request(`http://local/api/peers/discoveries?limit=${limit}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "invalid_limit", hint: "limit must be a positive number" });
    }
  });
});
