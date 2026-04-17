/**
 * federation-symmetric — getFederationStatusSymmetric pair-health classifier.
 *
 * These tests use the `SymmetricDeps` injection API to drive the function
 * with synthetic baseline + fetcher data. No mock.module — deliberately
 * placed in `test/` (not `test/isolated/`) because the DI seam means we
 * don't need process-global mocking at all.
 *
 * Iteration 4 of Bloom's federation audit caught a bug in bun-test's
 * `mock.module()`: two "isolated" test files both mocking the same
 * module cause cross-file wrapper layering that flips unrelated tests
 * from pass to fail. This file sidesteps the problem entirely by taking
 * the seam at the function parameter level, not the module level.
 *
 * See ψ/lab/federation-audit/pair-health-failure.md (mawjs-no2-oracle)
 * for the full invariant + failure-scenario catalogue.
 */
import { describe, test, expect } from "bun:test";
import {
  getFederationStatusSymmetric,
  type PairStatus,
  type PeerStatus,
} from "../src/core/transport/peers";

type FetchFn = (url: string, opts?: unknown) => Promise<{ ok: boolean; status: number; data?: unknown }>;
function fakeFetch(responses: Record<string, { ok: boolean; status: number; data?: unknown }>): FetchFn {
  return async (url: string) => responses[url] ?? { ok: false, status: 0 };
}

function baseWith(peers: PeerStatus[], localUrl = "http://localhost:3456") {
  return {
    localUrl,
    peers,
    totalPeers: peers.length,
    reachablePeers: peers.filter(p => p.reachable).length,
    clockHealth: { clockUtc: new Date().toISOString(), timezone: "UTC", uptimeSeconds: 0 },
  };
}

describe("getFederationStatusSymmetric — DI-testable classifier", () => {
  test("no peers → empty pairs, zero healthy/total", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([]),
      fetch: fakeFetch({}),
      localNode: "white",
    });
    expect(res.pairs).toEqual([]);
    expect(res.totalPairs).toBe(0);
    expect(res.healthyPairs).toBe(0);
    expect(res.localNode).toBe("white");
  });

  test("peer reachable AND local in peer's view marked reachable → healthy", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [{ url: "http://localhost:3456", node: "white", reachable: true }] },
        },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("healthy");
    expect(res.pairs[0].forward).toBe(true);
    expect(res.pairs[0].reverse).toBe(true);
    expect(res.healthyPairs).toBe(1);
  });

  test("peer reachable, local MISSING from peer's peer list → half-up", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [] },
        },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("half-up");
    expect(res.pairs[0].forward).toBe(true);
    expect(res.pairs[0].reverse).toBe(false);
    expect(res.pairs[0].reason).toMatch(/not in peer/);
  });

  test("peer has local in view but marks us unreachable → half-up", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [{ url: "http://localhost:3456", node: "white", reachable: false }] },
        },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("half-up");
    expect(res.pairs[0].reason).toMatch(/unreachable/);
  });

  test("peer forward-unreachable → down (no reverse check attempted)", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: false, latency: 0 }]),
      fetch: fakeFetch({}),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("down");
    expect(res.pairs[0].forward).toBe(false);
    expect(res.pairs[0].reverse).toBeNull();
    expect(res.pairs[0].reason).toMatch(/forward unreachable/);
  });

  test("forward OK but peer /api/federation/status returns non-ok → unknown", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": { ok: false, status: 500 },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("unknown");
    expect(res.pairs[0].forward).toBe(true);
    expect(res.pairs[0].reverse).toBeNull();
    expect(res.pairs[0].reason).toMatch(/returned 500/);
  });

  test("forward OK but peer fetch throws → unknown with reason", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: async () => { throw new Error("network cable unplugged"); },
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("unknown");
    expect(res.pairs[0].reason).toMatch(/network cable/);
  });

  test("matches local by node identity when URL differs (peer uses WG IP, we use localhost)", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [{ url: "http://10.0.0.1:3456", node: "white", reachable: true }] },
        },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("healthy");
  });

  test("matches local by URL when node identity is absent (legacy peer)", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith(
        [{ url: "http://mba:3456", reachable: true, latency: 40 }],
        "http://localhost:3456",
      ),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [{ url: "http://localhost:3456", reachable: true }] },
        },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("healthy");
  });

  test("three-peer mesh with mixed states → 1 healthy, 1 half-up, 1 down", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([
        { url: "http://alpha:3456", reachable: true, latency: 10, node: "alpha" },
        { url: "http://bravo:3456", reachable: true, latency: 20, node: "bravo" },
        { url: "http://charlie:3456", reachable: false, latency: 0 },
      ]),
      fetch: fakeFetch({
        "http://alpha:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [{ url: "http://localhost:3456", node: "white", reachable: true }] },
        },
        "http://bravo:3456/api/federation/status": {
          ok: true, status: 200,
          data: { peers: [] }, // we're not in bravo's view
        },
      }),
      localNode: "white",
    });
    expect(res.totalPairs).toBe(3);
    expect(res.healthyPairs).toBe(1);
    const states: PairStatus["pair"][] = res.pairs.map(p => p.pair).sort();
    expect(states).toEqual(["down", "half-up", "healthy"]);
  });

  test("peer response lacks `peers` field entirely → half-up (defensive)", async () => {
    const res = await getFederationStatusSymmetric({
      baseStatus: baseWith([{ url: "http://mba:3456", reachable: true, latency: 40, node: "mba" }]),
      fetch: fakeFetch({
        "http://mba:3456/api/federation/status": {
          ok: true, status: 200,
          data: {},  // no peers field at all
        },
      }),
      localNode: "white",
    });
    expect(res.pairs[0].pair).toBe("half-up");
  });
});
