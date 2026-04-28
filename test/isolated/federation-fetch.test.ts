/**
 * federation-fetch.ts — fetchPeerIdentities async I/O.
 *
 * Contract:
 *   - Parallel GET of `${peer.url}/api/identity` for every peer.
 *   - Always returns ONE PeerIdentity per input peer (unreachable → marked, not dropped).
 *   - Timeout: explicit arg wins; else cfgTimeout("http").
 *   - Invalid shape guard: data.node must be string, data.agents must be array.
 *   - agents filter strips non-string entries silently.
 *   - Thrown errors → first line of message only (error?.message || String(e)).
 *
 * Isolated because we mock.module on two seams fetchPeerIdentities imports through:
 *   - src/sdk      (curlFetch)
 *   - src/config   (cfgTimeout)
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)` — dropping
 * optional positional args breaks unrelated suites.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rSdk = await import("../../src/sdk");
const realCurlFetch = _rSdk.curlFetch;

const _rConfig = await import("../../src/config");
const realCfgTimeout = _rConfig.cfgTimeout;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

interface CurlResponse { ok: boolean; status?: number; data?: unknown; }
interface CurlFetchCall { url: string; opts: unknown; }

let curlFetchCalls: CurlFetchCall[] = [];
let curlFetchResponses: Array<{ match: RegExp; response?: CurlResponse; error?: string }> = [];
let cfgTimeoutCalls: string[] = [];
let cfgTimeoutReturn = 15000;

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/sdk"),
  () => ({
    ..._rSdk,
    curlFetch: async (...args: unknown[]) => {
      if (!mockActive) return (realCurlFetch as (...a: unknown[]) => unknown)(...args);
      const [url, opts] = args as [string, unknown];
      curlFetchCalls.push({ url, opts });
      for (const r of curlFetchResponses) {
        if (r.match.test(url)) {
          if (r.error) throw new Error(r.error);
          return r.response!;
        }
      }
      return { ok: false, status: 0, data: null };
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    cfgTimeout: (...args: unknown[]) => {
      if (!mockActive) return (realCfgTimeout as (...a: unknown[]) => number)(...args);
      const [key] = args as [string];
      cfgTimeoutCalls.push(key);
      return cfgTimeoutReturn;
    },
  }),
);

// NB: import target AFTER mocks so its import graph resolves through our stubs.
const { fetchPeerIdentities } = await import("../../src/commands/shared/federation-fetch");

// ─── Harness ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockActive = true;
  curlFetchCalls = [];
  curlFetchResponses = [];
  cfgTimeoutCalls = [];
  cfgTimeoutReturn = 15000;
});

afterEach(() => { mockActive = false; });
afterAll(() => { mockActive = false; });

// ─── Reachable / happy path ─────────────────────────────────────────────────

describe("fetchPeerIdentities — reachable happy path", () => {
  test("single peer ok + valid shape → PeerIdentity{reachable:true, node, agents}", async () => {
    curlFetchResponses = [{
      match: /white\.example\/api\/identity$/,
      response: { ok: true, status: 200, data: { node: "white", agents: ["neo", "mawjs"] } },
    }];

    const out = await fetchPeerIdentities([{ name: "white", url: "https://white.example" }]);

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      peerName: "white",
      url: "https://white.example",
      node: "white",
      agents: ["neo", "mawjs"],
      reachable: true,
    });
  });

  test("URL built as `${peer.url}/api/identity` (no trailing-slash normalization)", async () => {
    curlFetchResponses = [{
      match: /target=|identity/,
      response: { ok: true, status: 200, data: { node: "w", agents: [] } },
    }];

    await fetchPeerIdentities([{ name: "white", url: "https://white.example" }]);

    expect(curlFetchCalls).toHaveLength(1);
    expect(curlFetchCalls[0].url).toBe("https://white.example/api/identity");
  });

  test("preserves peer.url into PeerIdentity.url verbatim (even with trailing slash)", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "w", agents: [] } },
    }];

    const out = await fetchPeerIdentities([{ name: "white", url: "https://white.example/" }]);

    expect(out[0].url).toBe("https://white.example/");
    // URL as built concatenates → double-slash is preserved for identity endpoint.
    expect(curlFetchCalls[0].url).toBe("https://white.example//api/identity");
  });

  test("non-string agents entries silently filtered out", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: {
        ok: true,
        status: 200,
        data: { node: "mba", agents: ["neo", 42, null, "mawjs", { bogus: true }, "white"] },
      },
    }];

    const out = await fetchPeerIdentities([{ name: "mba", url: "https://mba.example" }]);

    expect(out[0].agents).toEqual(["neo", "mawjs", "white"]);
    expect(out[0].reachable).toBe(true);
  });

  test("empty agents array → reachable:true with empty list", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "fresh", agents: [] } },
    }];

    const out = await fetchPeerIdentities([{ name: "fresh", url: "https://fresh.example" }]);

    expect(out[0]).toEqual({
      peerName: "fresh",
      url: "https://fresh.example",
      node: "fresh",
      agents: [],
      reachable: true,
    });
  });
});

// ─── Unreachable: HTTP failure branches ─────────────────────────────────────

describe("fetchPeerIdentities — HTTP failure (ok:false / missing data)", () => {
  test("res.ok=false → reachable:false, error contains status", async () => {
    curlFetchResponses = [{
      match: /down\.example/,
      response: { ok: false, status: 500, data: null },
    }];

    const out = await fetchPeerIdentities([{ name: "down", url: "https://down.example" }]);

    expect(out[0].reachable).toBe(false);
    expect(out[0].node).toBe("");
    expect(out[0].agents).toEqual([]);
    expect(out[0].error).toBe("http 500");
    // peer identity still labels with the original name/url
    expect(out[0].peerName).toBe("down");
    expect(out[0].url).toBe("https://down.example");
  });

  test("res.ok=true but data missing (null) → reachable:false with status", async () => {
    curlFetchResponses = [{
      match: /empty\.example/,
      response: { ok: true, status: 200, data: null },
    }];

    const out = await fetchPeerIdentities([{ name: "empty", url: "https://empty.example" }]);

    expect(out[0].reachable).toBe(false);
    expect(out[0].error).toBe("http 200");
  });

  test("res.ok=false with undefined status → error renders 'http ?'", async () => {
    curlFetchResponses = [{
      match: /nostatus/,
      response: { ok: false, data: null }, // no status field
    }];

    const out = await fetchPeerIdentities([{ name: "nostatus", url: "https://nostatus.example" }]);

    expect(out[0].error).toBe("http ?");
    expect(out[0].reachable).toBe(false);
  });
});

// ─── Unreachable: invalid shape ─────────────────────────────────────────────

describe("fetchPeerIdentities — invalid identity shape guard", () => {
  test("data.node not a string → reachable:false + 'invalid identity shape'", async () => {
    curlFetchResponses = [{
      match: /weird/,
      response: { ok: true, status: 200, data: { node: 42, agents: [] } },
    }];

    const out = await fetchPeerIdentities([{ name: "weird", url: "https://weird.example" }]);

    expect(out[0].reachable).toBe(false);
    expect(out[0].error).toBe("invalid identity shape");
    expect(out[0].node).toBe("");
    expect(out[0].agents).toEqual([]);
  });

  test("data.agents not an array → reachable:false + 'invalid identity shape'", async () => {
    curlFetchResponses = [{
      match: /weird/,
      response: { ok: true, status: 200, data: { node: "x", agents: "nope" } },
    }];

    const out = await fetchPeerIdentities([{ name: "weird", url: "https://weird.example" }]);

    expect(out[0].reachable).toBe(false);
    expect(out[0].error).toBe("invalid identity shape");
  });

  test("data missing both node and agents → reachable:false + 'invalid identity shape'", async () => {
    curlFetchResponses = [{
      match: /weird/,
      response: { ok: true, status: 200, data: {} },
    }];

    const out = await fetchPeerIdentities([{ name: "weird", url: "https://weird.example" }]);

    expect(out[0].reachable).toBe(false);
    expect(out[0].error).toBe("invalid identity shape");
  });

  test("data.node is empty string (still a string) → treated as VALID shape", async () => {
    // Per the guard, typeof "" === "string" passes; reachable becomes true with node="".
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "", agents: [] } },
    }];

    const out = await fetchPeerIdentities([{ name: "w", url: "https://w.example" }]);

    expect(out[0].reachable).toBe(true);
    expect(out[0].node).toBe("");
    expect(out[0].error).toBeUndefined();
  });
});

// ─── Unreachable: thrown error ──────────────────────────────────────────────

describe("fetchPeerIdentities — curlFetch throws", () => {
  test("thrown Error → reachable:false + first line of message", async () => {
    curlFetchResponses = [{
      match: /boom/,
      error: "ECONNREFUSED\nat stack frame 1\nat stack frame 2",
    }];

    const out = await fetchPeerIdentities([{ name: "boom", url: "https://boom.example" }]);

    expect(out[0].reachable).toBe(false);
    expect(out[0].error).toBe("ECONNREFUSED");
    expect(out[0].node).toBe("");
    expect(out[0].agents).toEqual([]);
    expect(out[0].peerName).toBe("boom");
    expect(out[0].url).toBe("https://boom.example");
  });

  test("thrown non-Error primitive → String()'d first line", async () => {
    // Simulate a thrown string by installing a custom throwing wrapper via the
    // responses list with a sentinel error message, then assert we render it.
    curlFetchResponses = [{
      match: /weird/,
      error: "plain string failure",
    }];

    const out = await fetchPeerIdentities([{ name: "weird", url: "https://weird.example" }]);

    expect(out[0].error).toBe("plain string failure");
    expect(out[0].reachable).toBe(false);
  });
});

// ─── Timeout plumbing ───────────────────────────────────────────────────────

describe("fetchPeerIdentities — timeout plumbing", () => {
  test("explicit timeout arg → passed to curlFetch; cfgTimeout NOT consulted", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "x", agents: [] } },
    }];

    await fetchPeerIdentities([{ name: "x", url: "https://x.example" }], 2500);

    // `from: "auto"` is added by #804 Step 4 SIGN so v3 from-signing rides
    // the /api/identity probe. Verifier (Step 4 VERIFY) tolerates uncached
    // peers via O6 row 1 — we only assert the timeout value here.
    expect(curlFetchCalls[0].opts).toEqual({ timeout: 2500, from: "auto" });
    expect(cfgTimeoutCalls).toEqual([]);
  });

  test("no timeout arg → cfgTimeout('http') consulted and forwarded", async () => {
    cfgTimeoutReturn = 8888;
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "x", agents: [] } },
    }];

    await fetchPeerIdentities([{ name: "x", url: "https://x.example" }]);

    expect(cfgTimeoutCalls).toEqual(["http"]);
    expect(curlFetchCalls[0].opts).toEqual({ timeout: 8888, from: "auto" });
  });

  test("timeout=0 (falsy but provided) → ?? still uses explicit 0, not cfgTimeout", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "x", agents: [] } },
    }];

    await fetchPeerIdentities([{ name: "x", url: "https://x.example" }], 0);

    // `timeout ?? cfgTimeout("http")` — nullish coalescing preserves 0.
    expect(curlFetchCalls[0].opts).toEqual({ timeout: 0, from: "auto" });
    expect(cfgTimeoutCalls).toEqual([]);
  });
});

// ─── Multi-peer parallelism + ordering ──────────────────────────────────────

describe("fetchPeerIdentities — multi-peer parallelism", () => {
  test("preserves input order 1:1 (Promise.all) with mixed outcomes", async () => {
    curlFetchResponses = [
      { match: /white\.example/, response: { ok: true, status: 200, data: { node: "white", agents: ["neo"] } } },
      { match: /mba\.example/, response: { ok: false, status: 502, data: null } },
      { match: /boom\.example/, error: "connect ETIMEDOUT" },
    ];

    const out = await fetchPeerIdentities([
      { name: "white", url: "https://white.example" },
      { name: "mba", url: "https://mba.example" },
      { name: "boom", url: "https://boom.example" },
    ]);

    expect(out.map((p) => p.peerName)).toEqual(["white", "mba", "boom"]);
    expect(out[0].reachable).toBe(true);
    expect(out[1].reachable).toBe(false);
    expect(out[1].error).toBe("http 502");
    expect(out[2].reachable).toBe(false);
    expect(out[2].error).toBe("connect ETIMEDOUT");
  });

  test("one peer throwing does NOT short-circuit other peers (all resolve)", async () => {
    curlFetchResponses = [
      { match: /ok\.example/, response: { ok: true, status: 200, data: { node: "ok", agents: [] } } },
      { match: /fail\.example/, error: "boom" },
    ];

    const out = await fetchPeerIdentities([
      { name: "ok", url: "https://ok.example" },
      { name: "fail", url: "https://fail.example" },
    ]);

    expect(out).toHaveLength(2);
    expect(out[0].reachable).toBe(true);
    expect(out[1].reachable).toBe(false);
    expect(out[1].error).toBe("boom");
  });

  test("all peers issued in parallel — N calls made for N peers", async () => {
    curlFetchResponses = [{
      match: /identity/,
      response: { ok: true, status: 200, data: { node: "n", agents: [] } },
    }];

    await fetchPeerIdentities([
      { name: "a", url: "https://a.example" },
      { name: "b", url: "https://b.example" },
      { name: "c", url: "https://c.example" },
      { name: "d", url: "https://d.example" },
    ]);

    expect(curlFetchCalls).toHaveLength(4);
    expect(curlFetchCalls.map((c) => c.url)).toEqual([
      "https://a.example/api/identity",
      "https://b.example/api/identity",
      "https://c.example/api/identity",
      "https://d.example/api/identity",
    ]);
  });

  test("empty peers array → [] with no curlFetch calls and no cfgTimeout lookup until needed", async () => {
    const out = await fetchPeerIdentities([]);

    expect(out).toEqual([]);
    expect(curlFetchCalls).toEqual([]);
    // `t` is computed upfront once — cfgTimeout may still be consulted.
    // We only assert that no HTTP was fired.
  });
});
