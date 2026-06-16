import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
const NOW = Date.parse("2026-05-16T00:00:00.000Z");

let federationCalls = 0;
let peers: any[] = [];

mock.module("maw-js/sdk", () => ({
  getFederationStatus: async () => {
    federationCalls += 1;
    return { localUrl: "http://local", peers: [{ name: "m5" }], totalPeers: 1, reachablePeers: 1 };
  },
  getTransportRouter: () => ({
    listDiscoveredPeers: () => peers,
  }),
}));

const plugin = await import("../../src/vendor/mpr-plugins/serve-federation/index.ts?plugin-serve-federation-standalone");

function peer(overrides: Record<string, unknown> = {}) {
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

async function json(response: Response): Promise<unknown> {
  return await response.json();
}

describe("serve-federation plugin standalone boundary (#2444)", () => {
  test("imports federation/discovery operations only through the SDK and serve types", () => {
    expectStandalonePluginBoundary({ plugin: "serve-federation" });
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/serve-federation/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).toContain('from "maw-js/plugin/types"');
  });

  test("registers federation status and discovered-peer routes", async () => {
    federationCalls = 0;
    peers = [peer({ zid: "newer", node: "newer", lastSeen: NOW - 1_000 })];
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();

    plugin.serve({
      http: {
        route(method, path, handler) {
          routes.set(`${method} ${path}`, handler);
        },
      },
    });

    expect([...routes.keys()].sort()).toEqual([
      "GET /api/federation/status",
      "GET /api/peers/discovered",
      "GET /api/peers/discoveries",
    ]);

    const status = await routes.get("GET /api/federation/status")!(new Request("http://local/api/federation/status"));
    expect(status.status).toBe(200);
    expect(await json(status)).toMatchObject({ localUrl: "http://local", totalPeers: 1, reachablePeers: 1 });
    expect(federationCalls).toBe(1);

    const discovered = await routes.get("GET /api/peers/discovered")!(new Request("http://local/api/peers/discovered?all=1"));
    expect(discovered.status).toBe(200);
    expect(await json(discovered)).toMatchObject({ ok: true, peers: [{ zid: "newer", node: "newer" }] });
  });

  test("preserves discovered-peer filtering, sorting, limits, and validation", async () => {
    const handlers = plugin.createFederationRouteHandlers({
      getFederationStatus: async () => ({ ok: true }) as any,
      now: () => NOW,
      listDiscoveredPeers: () => [
        peer({ zid: "paired", node: "paired-node", paired: true, lastSeen: NOW - 1_000 }),
        peer({ zid: "fresh-b", node: "beta", lastSeen: NOW - 5_000 }),
        peer({ zid: "fresh-a", node: "alpha", lastSeen: NOW - 5_000 }),
      ],
    });

    const filtered = await handlers.discoveries(new Request("http://local/api/peers/discoveries"));
    expect(filtered.status).toBe(200);
    expect(await json(filtered)).toMatchObject({
      ok: true,
      total: 2,
      shown: 2,
      filtered: true,
      peers: [{ zid: "fresh-a", seenRel: "5s" }, { zid: "fresh-b", seenRel: "5s" }],
    });

    const limited = await handlers.discoveries(new Request("http://local/api/peers/discoveries?all=true&limit=1"));
    expect(await json(limited)).toMatchObject({ total: 3, shown: 1, filtered: false, peers: [{ zid: "paired" }] });

    for (const limit of ["wat", "0", "-1"]) {
      const res = await handlers.discoveries(new Request(`http://local/api/peers/discoveries?limit=${limit}`));
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ ok: false, error: "invalid_limit", hint: "limit must be a positive number" });
    }
  });
});
