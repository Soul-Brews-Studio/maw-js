import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

let fetchProbeResult: {
  node: string | null;
  nickname?: string | null;
  pubkey?: string;
  identity?: { oracle: string; node: string };
  error?: { code: string; message: string; at: string };
} | null = null;

let probeModule: typeof import("../../src/vendor/mpr-plugins/peers/probe");

// DNS mock is intentionally shared for all `probePeer` tests.
mock.module("dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "dns-fail.local") {
      const err: NodeJS.ErrnoException = new Error("dns fail") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    }
    return { address: "127.0.0.1", family: 4 };
  },
}));

function serve(pathname: string, status: number, body: unknown, headers?: HeadersInit) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== pathname) return new Response("not found", { status: 404 });
      if (status >= 400) return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
      if (typeof body === "string") return new Response(body, { status });
      return Response.json(body, { status, headers });
    },
  });
}

beforeAll(async () => {
  probeModule = await import("../../src/vendor/mpr-plugins/peers/probe");
});

describe("peers probe coverage slice", () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  test("classifies probe branches and hints", () => {
    expect(probeModule.classifyProbeError({ ok: false, status: 404 })).toBe("HTTP_4XX");
    expect(probeModule.classifyProbeError({ ok: false, status: 503 })).toBe("HTTP_5XX");
    expect(probeModule.classifyProbeError({ ok: false, status: 302 })).toBe("UNKNOWN");
    expect(probeModule.classifyProbeError({ name: "AbortError" })).toBe("TIMEOUT");
    expect(probeModule.classifyProbeError({ code: "CERT_CHAIN_INVALID" })).toBe("TLS");
    expect(probeModule.classifyProbeError({ code: "ECONNREFUSED" })).toBe("REFUSED");
    expect(probeModule.classifyProbeError({ code: "ENOTIMP", cause: { code: "ENOTIMP" } })).toBe("DNS");

    expect(probeModule.pickHint({ code: "DNS", message: "ENOTIMP", at: "x" })).toContain("avahi-daemon");
    expect(probeModule.pickHint({ code: "DNS", message: "EAI_FAIL", at: "x" })).toBe(probeModule.PROBE_HINTS.DNS);
    expect(probeModule.isValidMawHandshake({ schema: "1" })).toBe(true);
    expect(probeModule.isValidMawHandshake({ schema: "" })).toBe(false);
  });

  test("validates handshake and rejects malformed /info payload", async () => {
    const info = serve("/info", 200, { maw: "yes" });
    const result = await probeModule.probePeer(`http://127.0.0.1:${info.port}`);
    expect(result).toMatchObject({ node: null, error: { code: "BAD_BODY" } });
    info.stop();

    const missingNode = serve("/info", 200, { maw: true, nickname: "nameless" });
    const noNode = await probeModule.probePeer(`http://127.0.0.1:${missingNode.port}`);
    expect(noNode).toMatchObject({ node: null, error: { code: "BAD_BODY", message: '/info response had neither "node" nor "name" string' } });
    missingNode.stop();
  });

  test("reports HTTP failures from /info without parsing bodies", async () => {
    const server = serve("/info", 404, "missing");
    const result = await probeModule.probePeer(`http://127.0.0.1:${server.port}`);
    expect(result).toMatchObject({ node: null, error: { code: "HTTP_4XX", message: `HTTP 404 from http://127.0.0.1:${server.port}/info` } });
    server.stop();
  });

  test("returns DNS classification before fetch", async () => {
    const result = await probeModule.probePeer("http://dns-fail.local:3333");
    expect(result).toMatchObject({ node: null, error: { code: "DNS", message: "dns fail" } });
  });

  test("succeeds on valid /info and parses optional identity w/default oracle", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/info") return Response.json({ maw: true, node: "peer-node", nickname: "nick" });
        if (url.pathname === "/api/identity") return Response.json({ pubkey: "k", node: "peer-node" });
        return new Response("not found", { status: 404 });
      },
    });
    const result = await probeModule.probePeer(`http://127.0.0.1:${server.port}`);
    expect(result).toMatchObject({
      node: "peer-node",
      nickname: "nick",
      pubkey: "k",
      identity: { oracle: "mawjs", node: "peer-node" },
    });
    server.stop();
  });

  test("keeps /info success when identity endpoint returns malformed JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/info") return Response.json({ maw: true, node: "peer-node" });
        if (url.pathname === "/api/identity") return new Response("not-json");
        return new Response("not found", { status: 404 });
      },
    });
    await expect(probeModule.probePeer(`http://127.0.0.1:${server.port}`)).resolves.toEqual({
      node: "peer-node",
      nickname: null,
    });
    server.stop();
  });

  test("classifies fetch failure as timeout", async () => {
    const original = globalThis.fetch;
    const timeoutErr = new Error("timed out") as Error & { name: string };
    timeoutErr.name = "TimeoutError";
    globalThis.fetch = (async () => { throw timeoutErr; }) as typeof fetch;
    const result = await probeModule.probePeer("http://127.0.0.1:49999", 10);
    expect(result).toMatchObject({ node: null, error: { code: "TIMEOUT" } });
    globalThis.fetch = original;
  });

  test("timer callbacks abort /info failures and best-effort identity fetches", async () => {
    globalThis.setTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
      if (typeof fn === "function") fn(...args as []);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      const err = new Error("aborted by timer") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    await expect(probeModule.probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "TIMEOUT", message: "aborted by timer" },
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/info") return Response.json({ maw: true, node: "timer-ok" });
      expect(init?.signal?.aborted).toBe(true);
      const err = new Error("identity timer") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    await expect(probeModule.probePeer("http://127.0.0.1:3456", 25)).resolves.toEqual({
      node: "timer-ok",
      nickname: null,
    });
  });

  test("returns BAD_BODY when /info response JSON parse fails", async () => {
    const bad = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not-json", { status: 200 });
      },
    });
    const result = await probeModule.probePeer(`http://127.0.0.1:${bad.port}`);
    expect(result.error?.code).toBe("BAD_BODY");
    bad.stop();
  });

  test("formats probe errors for CLI output", () => {
    const text = probeModule.formatProbeError(
      { code: "DNS", message: "ENOTFOUND dns-fail.local", at: "2026-05-18T00:00:00.000Z" },
      "https://dns-fail.local:5555",
      "alice",
    );
    expect(text).toContain("peer handshake failed");
    expect(text).toContain("alice");
    expect(text).toContain("retry: maw peers probe alice");
    expect(probeModule.formatProbeError(
      { code: "UNKNOWN", message: "bad url", at: "2026-05-18T00:00:00.000Z" },
      "not a url",
      "bad",
    )).toContain("host: not a url");
  });
});

describe("peers impl coverage slice", () => {
  const storePath = import.meta.dir + "/../../src/vendor/mpr-plugins/peers/store.ts";
  const tofuPath = import.meta.dir + "/../../src/vendor/mpr-plugins/peers/tofu.ts";
  const probePath = import.meta.dir + "/../../src/vendor/mpr-plugins/peers/probe.ts";

  let implModule: typeof import("../../src/vendor/mpr-plugins/peers/impl");
  let peers: Record<string, any> = {};
  let evaluateDecision: {
    kind: "match" | "mismatch" | "tofu-bootstrap" | "legacy-first-contact" | "legacy-after-pinned";
    alias: string;
    message: string;
    cached?: string;
    observed?: string;
  } = { kind: "match", alias: "x", message: "ok" };
  let probeCalls: string[] = [];
  let tofuCalls: Array<{ alias: string; kind: string }> = [];
  let forgetOutcome: "cleared" | "no-pubkey" | "not-found" = "cleared";

  beforeAll(async () => {
    mock.module(storePath, () => ({
      loadPeers: () => ({ peers }),
      mutatePeers: (mutate: (data: any) => void) => {
        const data = { peers: { ...peers } };
        mutate(data);
        peers = data.peers;
      },
      getStaleTtlMs: () => 1000,
      isStale: () => true,
      staleAgeMs: () => 42_000,
    }));

  mock.module(tofuPath, () => ({
      evaluatePeerIdentity: (alias: string, existing: any, observed: string | undefined) => ({
        ...evaluateDecision,
        alias,
        cached: existing?.pubkey,
        observed,
      }),
      applyTofuDecision: (decision: { alias: string; kind: string }) => {
        tofuCalls.push({ alias: decision.alias, kind: decision.kind });
      },
      PeerPubkeyMismatchError: class extends Error {
        alias: string;
        cached: string;
        observed: string;
        constructor(alias: string, cached: string, observed: string) {
          super(`peer pubkey changed for ${alias}: ${cached} → ${observed}`);
          this.alias = alias;
          this.cached = cached;
          this.observed = observed;
        }
      },
      forgetPeerPubkey: (alias: string) => {
        if (alias === "missing") return "not-found";
        if (alias === "legacy") return "no-pubkey";
        return forgetOutcome;
      },
    }));

    mock.module(probePath, () => ({
      probePeer: async (url: string) => {
        probeCalls.push(url);
        return fetchProbeResult ?? { node: "probe-node" };
      },
    }));

    implModule = await import("../../src/vendor/mpr-plugins/peers/impl");
  });

  beforeEach(() => {
    peers = {};
    evaluateDecision = { kind: "match", alias: "x", message: "ok" };
    probeCalls = [];
    tofuCalls = [];
    fetchProbeResult = null;
    forgetOutcome = "cleared";
    delete process.env.MAW_PEER_STALE_TTL_MS;
  });

  test("validates alias/url and resolveNode fallback", async () => {
    expect(implModule.validateAlias("Bad_Alias")).toContain("invalid alias");
    expect(implModule.validateUrl("ftp://127.0.0.1:1")).toContain("invalid URL");
    expect(implModule.validateAlias("OkAlias")).toContain("invalid alias");
    expect(await implModule.resolveNode("https://example.org")).toBe("probe-node");
    fetchProbeResult = { node: null, error: { code: "UNKNOWN", message: "x", at: new Date().toISOString() } };
    expect(await implModule.resolveNode("https://example.org")).toBeNull();
  });

  test("cmdAdd probes, persists result, overrides node when requested", async () => {
    fetchProbeResult = {
      node: "remote-node",
      nickname: "nick",
      identity: { oracle: "mawjs", node: "remote-node" },
    };
    const result = await implModule.cmdAdd({ alias: "alice", url: "http://127.0.0.1:1", node: "override-node" });
    expect(result.overwrote).toBe(false);
    expect(result.peer.node).toBe("override-node");
    expect(result.peer.nickname).toBe("nick");
    expect(result.peer.identity).toEqual({ oracle: "mawjs", node: "remote-node" });
    expect(peers.alice).toMatchObject({ url: "http://127.0.0.1:1", node: "override-node", nickname: "nick" });
    expect(probeCalls).toEqual(["http://127.0.0.1:1"]);

    peers.alice.pubkey = "p";
    peers.alice.pubkeyFirstSeen = "seed";
    const second = await implModule.cmdAdd({ alias: "alice", url: "http://127.0.0.1:1" });
    expect(second.overwrote).toBe(true);
    expect(second.peer.pubkey).toBe("p");
  });

  test("cmdAdd surfaces TOFU mismatch and preserves existing entry", async () => {
    peers = { alice: { node: "old", url: "http://127.0.0.1:1", addedAt: "x", lastSeen: null } };
    evaluateDecision = {
      kind: "mismatch",
      alias: "alice",
      message: "changed",
      cached: "old",
      observed: "new",
    };
    fetchProbeResult = { node: "peer-node" };
    const mismatch = await implModule.cmdAdd({ alias: "alice", url: "http://127.0.0.1:1" });
    expect(mismatch.overwrote).toBe(true);
    expect(mismatch.pubkeyMismatch).toBeDefined();
    expect(mismatch.peer).toEqual(peers.alice);
    expect(mismatch.probeError).toBeUndefined();
  });

  test("cmdProbe updates and surfaces mismatch path", async () => {
    peers = { bob: { node: "old", url: "http://127.0.0.1:1", addedAt: "x", lastSeen: "seed" } };
    fetchProbeResult = { node: "new-node", nickname: "peer", identity: { oracle: "mawjs", node: "new-node" } };
    evaluateDecision = { kind: "match", alias: "bob", message: "ok", cached: "abc", observed: "abc" };
    const good = await implModule.cmdProbe("bob");
    expect(good.ok).toBe(true);
    expect(good.node).toBe("new-node");
    expect(peers.bob).toMatchObject({ node: "new-node", nickname: "peer", identity: { oracle: "mawjs", node: "new-node" } });

    evaluateDecision = { kind: "mismatch", alias: "bob", message: "changed", cached: "old", observed: "new" };
    fetchProbeResult = { node: "oops", error: { code: "UNKNOWN", message: "bad", at: new Date().toISOString() } };
    const bad = await implModule.cmdProbe("bob");
    expect(bad.ok).toBe(false);
    expect(bad.pubkeyMismatch).toBeDefined();
    expect(bad.node).toBe("oops");
  });

  test("list/info/remove/forget + formatList branches", async () => {
    peers = {
      b: { url: "http://b", node: "n2", addedAt: "x", lastSeen: "2026-01-01" },
      a: { url: "http://a", node: null, addedAt: "x", lastSeen: null },
    };

    const rows = implModule.cmdList();
    expect(rows.map((r: { alias: string }) => r.alias)).toEqual(["a", "b"]);
    expect(rows[0].stale).toBe(true);
    expect(rows[0].staleAgeMs).toBe(42000);
    expect(implModule.cmdInfo("a")?.url).toBe("http://a");
    expect(implModule.cmdInfo("missing")).toBeNull();
    expect(implModule.cmdRemove("a")).toBe(true);
    expect(implModule.cmdRemove("missing")).toBe(false);

    forgetOutcome = "cleared";
    expect(await implModule.cmdForget("a")).toBe("cleared");
    expect(await implModule.cmdForget("legacy")).toBe("no-pubkey");
    expect(await implModule.cmdForget("missing")).toBe("not-found");

    const formatted = implModule.formatList(rows);
    expect(formatted).toContain("alias");
    expect(formatted).toContain("(stale,");
    expect(formatted).toContain("last seen 0d ago");

    // Direct alias validation path in forget
    expect(implModule.validateAlias("Bad_alias")).toContain("invalid alias");
  });
});
