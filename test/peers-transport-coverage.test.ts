/**
 * Runtime coverage for peer federation transport helpers without touching live
 * peers. Mocks are gated and delegate when inactive so this default-suite file
 * does not pollute unrelated tests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Session } from "../src/core/transport/ssh";

const realConfig = await import("../src/config");
const realCurl = await import("../src/core/transport/curl-fetch");

let mockActive = false;
let config: any;
let responses: Array<{ match: string; res?: any; error?: Error; advanceMs?: number }> = [];
let curlCalls: Array<{ url: string; opts: any }> = [];
let warns: string[] = [];
let now = 1_700_000_000_000;
const originalWarn = console.warn;
const originalDateNow = Date.now;

mock.module(import.meta.resolve("../src/config"), () => ({
  ...realConfig,
  loadConfig: () => (mockActive ? config : realConfig.loadConfig()),
  cfgTimeout: (kind: Parameters<typeof realConfig.cfgTimeout>[0]) => (
    mockActive ? 1234 : realConfig.cfgTimeout(kind)
  ),
}));

mock.module(import.meta.resolve("../src/core/transport/curl-fetch"), () => ({
  ...realCurl,
  curlFetch: async (url: string, opts?: any) => {
    if (!mockActive) return realCurl.curlFetch(url, opts);
    curlCalls.push({ url, opts });
    const hit = responses.find((entry) => url.includes(entry.match));
    if (hit?.advanceMs) now += hit.advanceMs;
    if (hit?.error) throw hit.error;
    return hit?.res ?? { ok: false, status: 404, data: null };
  },
}));

const {
  findPeerForTarget,
  getAggregatedSessions,
  getFederationStatus,
  getFederationStatusSymmetric,
  getPeers,
  sendKeysToPeer,
  sendKeysToPeerDetailed,
} = await import("../src/core/transport/peers.ts?peers-transport-coverage");

beforeEach(() => {
  mockActive = true;
  now += 31_000; // expire the module-level aggregated-session cache between tests
  Date.now = () => now;
  config = { node: "m5", port: 3456, peers: [], namedPeers: [] };
  responses = [];
  curlCalls = [];
  warns = [];
  console.warn = (...parts: unknown[]) => { warns.push(parts.map(String).join(" ")); };
});

afterEach(() => {
  console.warn = originalWarn;
  Date.now = originalDateNow;
  mockActive = false;
});

function session(name: string, windows: Array<{ name: string }> = [{ name: "main" }]): Session {
  return {
    name,
    windows: windows.map((window, index) => ({ index, name: window.name, active: index === 0 })),
  } as Session;
}

describe("peer configuration and session aggregation", () => {
  test("getPeers merges flat and named peers with first-seen URL dedupe", () => {
    config = {
      peers: ["http://a:3456", "http://b:3456"],
      namedPeers: [
        { name: "a-alias", url: "http://a:3456" },
        { name: "c", url: "http://c:3456" },
      ],
    };

    expect(getPeers()).toEqual(["http://a:3456", "http://b:3456", "http://c:3456"]);
  });

  test("getAggregatedSessions returns local sessions unchanged when no peers are configured", async () => {
    const local = [session("local", [{ name: "lead" }])];

    await expect(getAggregatedSessions(local)).resolves.toBe(local);
    expect(curlCalls).toEqual([]);
  });

  test("getAggregatedSessions fetches peers, validates hostile rows, dedupes by source/name, and caches", async () => {
    config.peers = ["http://peer-a:3456", "http://peer-b:3456"];
    responses = [
      {
        match: "peer-a:3456/api/sessions?local=true",
        res: {
          ok: true,
          status: 200,
          data: [
            session("remote", [{ name: "oracle" }]),
            session("remote", [{ name: "dupe" }]),
            { name: "bad;rm -rf", windows: [] },
            { name: "no-windows" },
          ],
        },
      },
      {
        match: "peer-b:3456/api/sessions?local=true",
        res: {
          ok: true,
          status: 200,
          data: [session("remote", [{ name: "other" }])],
        },
      },
    ];

    const first = await getAggregatedSessions([session("local")]);
    expect(first.map((s) => `${s.source}:${s.name}`)).toEqual([
      "local:local",
      "http://peer-a:3456:remote",
      "http://peer-b:3456:remote",
    ]);
    expect(warns.join("\n")).toContain("dropped malformed session");
    expect(curlCalls).toHaveLength(2);

    responses = [];
    const second = await getAggregatedSessions([]);
    expect(second.map((s) => `${s.source}:${s.name}`)).toEqual([
      "http://peer-a:3456:remote",
      "http://peer-b:3456:remote",
    ]);
    expect(curlCalls).toHaveLength(2); // cache hit, no new peer fetch
  });

  test("peer session fetch failures, non-ok responses, and non-arrays fail closed", async () => {
    config.peers = ["http://down:3456", "http://bad:3456", "http://shape:3456"];
    responses = [
      { match: "down:3456/api/sessions?local=true", error: new Error("offline") },
      { match: "bad:3456/api/sessions?local=true", res: { ok: false, status: 500, data: [] } },
      { match: "shape:3456/api/sessions?local=true", res: { ok: true, status: 200, data: { nope: true } } },
    ];

    await expect(getAggregatedSessions([])).resolves.toEqual([]);
  });
});

describe("federation status", () => {
  test("getFederationStatus reports identity, agents, clock warning, and fastest URL per node", async () => {
    config = {
      node: "m5",
      port: 4567,
      peers: ["http://slow:3456", "http://fast:3456", "http://other:3456", "http://down:3456"],
    };
    responses = [
      { match: "localhost:4567/api/sessions", advanceMs: 3, res: { ok: true, status: 200, data: [] } },
      { match: "localhost:4567/api/identity", res: { ok: true, status: 200, data: { node: "m5", agents: ["local"] } } },
      { match: "slow:3456/api/sessions", advanceMs: 40, res: { ok: true, status: 200, data: [] } },
      { match: "slow:3456/api/identity", res: { ok: true, status: 200, data: { node: "same", agents: ["slow"], clockUtc: new Date(now + 4 * 60_000).toISOString() } } },
      { match: "fast:3456/api/sessions", advanceMs: 5, res: { ok: true, status: 200, data: [] } },
      { match: "fast:3456/api/identity", res: { ok: true, status: 200, data: { node: "same", agents: ["fast"], clockUtc: new Date(now).toISOString() } } },
      { match: "other:3456/api/sessions", advanceMs: 10, res: { ok: true, status: 200, data: [] } },
      { match: "other:3456/api/identity", res: { ok: true, status: 200, data: { node: "other", agents: ["neo"] } } },
      { match: "down:3456/api/sessions", error: new Error("ECONNREFUSED") },
    ];

    const status = await getFederationStatus();

    expect(status.localUrl).toBe("http://localhost:4567");
    expect(status.localReachable).toBe(true);
    expect(status.totalPeers).toBe(4);
    expect(status.reachablePeers).toBe(2); // fast same-node + other; down is unreachable and slow was deduped out
    expect(status.peers.map((p) => p.url).sort()).toEqual([
      "http://down:3456",
      "http://fast:3456",
      "http://other:3456",
    ]);
    expect(status.peers.find((p) => p.node === "same")?.agents).toEqual(["fast"]);
    expect(status.clockHealth).toMatchObject({ timezone: expect.any(String), uptimeSeconds: expect.any(Number) });
  });

  test("getFederationStatus keeps named peers separate when services share a host node (#1814)", async () => {
    config = {
      node: "m5",
      port: 4567,
      namedPeers: [
        { name: "white", url: "http://white:3456" },
        { name: "alpha", url: "http://white:3461" },
      ],
    };
    responses = [
      { match: "localhost:4567/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "localhost:4567/api/identity", res: { ok: true, status: 200, data: { node: "m5", agents: ["local"] } } },
      { match: "white:3456/api/sessions", advanceMs: 10, res: { ok: true, status: 200, data: [] } },
      { match: "white:3456/api/identity", res: { ok: true, status: 200, data: { node: "white", agents: ["nat"] } } },
      { match: "white:3461/api/sessions", advanceMs: 20, res: { ok: true, status: 200, data: [] } },
      { match: "white:3461/api/identity", res: { ok: true, status: 200, data: { node: "white", agents: ["alpha"] } } },
    ];

    const status = await getFederationStatus();

    expect(status.totalPeers).toBe(2);
    expect(status.reachablePeers).toBe(2);
    expect(status.peers.map((p) => [p.peerName, p.url, p.node, p.agents])).toEqual([
      ["white", "http://white:3456", "white", ["nat"]],
      ["alpha", "http://white:3461", "white", ["alpha"]],
    ]);
  });

  test("getFederationStatus accepts ephemeral peer inputs without mutating config", async () => {
    config = {
      node: "m5",
      port: 4567,
      peers: [],
      namedPeers: [],
    };
    responses = [
      { match: "localhost:4567/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "localhost:4567/api/identity", res: { ok: true, status: 200, data: { node: "m5", agents: ["local"] } } },
      { match: "scout:3456/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "scout:3456/api/identity", res: { ok: true, status: 200, data: { node: "scout", agents: ["pulse"] } } },
    ];

    const status = await getFederationStatus({
      config,
      peers: [{ name: "scout-node", url: "http://scout:3456" }],
    });

    expect(config.namedPeers).toEqual([]);
    expect(status.totalPeers).toBe(1);
    expect(status.peers).toEqual([
      {
        url: "http://scout:3456",
        peerName: "scout-node",
        reachable: true,
        latency: 0,
        node: "scout",
        agents: ["pulse"],
        clockDeltaMs: undefined,
        clockWarning: undefined,
      },
    ]);
  });

  test("getFederationStatus warns only when sessions succeed but identity fails", async () => {
    config.peers = ["http://identity-404:3456", "http://identity-throw:3456", "http://fully-down:3456"];
    responses = [
      { match: "localhost:3456/api/sessions", res: { ok: false, status: 0, data: null } },
      { match: "identity-404:3456/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "identity-404:3456/api/identity", res: { ok: false, status: 404, data: null } },
      { match: "identity-throw:3456/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "identity-throw:3456/api/identity", error: new Error("bad identity") },
      { match: "fully-down:3456/api/sessions", res: { ok: false, status: 503, data: null } },
      { match: "fully-down:3456/api/identity", error: new Error("should not warn") },
    ];

    const status = await getFederationStatus();

    expect(status.localReachable).toBe(false);
    expect(status.peers).toHaveLength(3);
    expect(warns.join("\n")).toContain("identity-404:3456/api/identity: status=404");
    expect(warns.join("\n")).toContain("identity-throw:3456/api/identity: bad identity");
    expect(warns.join("\n")).not.toContain("should not warn");
  });
});

describe("peer target lookup and send", () => {
  test("findPeerForTarget returns null for local targets and peer URL for remote session/window targets", async () => {
    config.peers = ["http://peer:3456"];
    responses = [
      {
        match: "peer:3456/api/sessions?local=true",
        res: { ok: true, status: 200, data: [session("remote", [{ name: "main" }, { name: "agent" }])] },
      },
    ];

    await expect(findPeerForTarget("local", [session("local")])).resolves.toBeNull();
    now += 31_000;
    await expect(findPeerForTarget("remote", [session("local")])).resolves.toBe("http://peer:3456");
    now += 31_000;
    await expect(findPeerForTarget("remote:agent", [session("local")])).resolves.toBe("http://peer:3456");
    now += 31_000;
    await expect(findPeerForTarget("missing", [session("local")])).resolves.toBeNull();
  });

  test("sendKeysToPeer signs send requests, reports body snippets, and catches thrown errors", async () => {
    responses = [{ match: "/api/send", res: { ok: true, status: 200, data: { ok: true, state: "queued", target: "remote:agent", lastLine: "stored" } } }];
    await expect(sendKeysToPeerDetailed("http://peer:3456", "remote:agent", "hello")).resolves.toEqual({
      ok: true,
      state: "queued",
      target: "remote:agent",
      lastLine: "stored",
    });
    expect(curlCalls[0]).toMatchObject({
      url: "http://peer:3456/api/send",
      opts: { method: "POST", timeout: 1234, from: "auto" },
    });
    expect(JSON.parse(curlCalls[0].opts.body)).toEqual({ target: "remote:agent", text: "hello" });

    responses = [{ match: "/api/send", res: { ok: true, status: 200, data: { ok: true } } }];
    await expect(sendKeysToPeerDetailed("http://peer:3456", "remote:agent", "hello")).resolves.toMatchObject({
      ok: true,
      state: "queued",
      target: "remote:agent",
    });
    await expect(sendKeysToPeer("http://peer:3456", "remote:agent", "hello")).resolves.toBe(true);

    responses = [{ match: "/api/send", res: { ok: false, status: 401, data: { error: "invalid hmac", detail: "x".repeat(260) } } }];
    await expect(sendKeysToPeer("http://peer:3456", "remote:agent", "hello")).resolves.toBe(false);
    expect(warns.join("\n")).toContain("status=401");
    expect(warns.join("\n")).toContain("invalid hmac");

    responses = [{ match: "/api/send", error: new Error("timeout") }];
    await expect(sendKeysToPeer("http://peer:3456", "remote:agent", "hello")).resolves.toBe(false);
    expect(warns.join("\n")).toContain("timeout");
  });
});

describe("symmetric status dependency seam", () => {
  test("getFederationStatusSymmetric can consume the default base status path", async () => {
    config = { node: "m5", port: 3456, peers: ["http://peer:3456"] };
    responses = [
      { match: "peer:3456/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "peer:3456/api/identity", res: { ok: true, status: 200, data: { node: "peer" } } },
      {
        match: "peer:3456/api/federation/status",
        res: { ok: true, status: 200, data: { peers: [{ node: "m5", reachable: true }] } },
      },
    ];

    await expect(getFederationStatusSymmetric()).resolves.toMatchObject({
      localUrl: "http://localhost:3456",
      localNode: "m5",
      healthyPairs: 1,
      totalPairs: 1,
      pairs: [{ pair: "healthy", forward: true, reverse: true }],
    });
  });
  test("getFederationStatusSymmetric classifies down, unknown, and half-up peer views through injected deps", async () => {
    const baseStatus = {
      localUrl: "http://local:3456",
      peers: [
        { url: "http://down:3456", reachable: false, latency: 9, node: "down" },
        { url: "http://status-fail:3456", reachable: true, node: "status-fail" },
        { url: "http://missing:3456", reachable: true, node: "missing" },
        { url: "http://reverse-down:3456", reachable: true, node: "reverse-down" },
        { url: "http://url-match:3456", reachable: true, node: "url-match" },
        { url: "http://throws:3456", reachable: true, node: "throws" },
      ],
      totalPeers: 6,
      reachablePeers: 5,
      clockHealth: { clockUtc: "2026-05-17T00:00:00.000Z", timezone: "UTC", uptimeSeconds: 1 },
    };
    const fetch = async (url: string) => {
      if (url.includes("status-fail")) return { ok: false, status: 503, data: null } as any;
      if (url.includes("missing")) return { ok: true, status: 200, data: { peers: [{ node: "other" }, { url: "http://else:3456" }] } } as any;
      if (url.includes("reverse-down")) return { ok: true, status: 200, data: { peers: [{ node: "m5", reachable: false }] } } as any;
      if (url.includes("url-match")) return { ok: true, status: 200, data: { peers: [{ url: "http://local:3456", reachable: true }] } } as any;
      throw new Error("peer boom");
    };

    const result = await getFederationStatusSymmetric({ baseStatus: baseStatus as any, fetch: fetch as any, localNode: "m5" });

    expect(result.healthyPairs).toBe(1);
    expect(result.pairs.map((p) => [p.url, p.pair, p.reverse, p.reason])).toEqual([
      ["http://down:3456", "down", null, "forward unreachable"],
      ["http://status-fail:3456", "unknown", null, "peer /api/federation/status returned 503"],
      ["http://missing:3456", "half-up", false, "local node not in peer's peer list"],
      ["http://reverse-down:3456", "half-up", false, "peer's view of local is unreachable"],
      ["http://url-match:3456", "healthy", true, undefined],
      ["http://throws:3456", "unknown", null, "peer status fetch failed: peer boom"],
    ]);
  });
});
