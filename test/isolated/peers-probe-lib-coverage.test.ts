import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let lookupCalls: string[] = [];
let lookupImpl: (host: string) => Promise<unknown> = async () => ({ address: "127.0.0.1", family: 4 });
let fetchCalls: Array<{ url: string; signal?: AbortSignal | null }> = [];
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

mock.module("dns/promises", () => ({
  lookup: (host: string) => {
    lookupCalls.push(host);
    return lookupImpl(host);
  },
}));

const {
  PROBE_EXIT_CODES,
  classifyProbeError,
  formatProbeError,
  isValidMawHandshake,
  pickHint,
  probePeer,
} = await import("../../src/lib/peers/probe.ts?peers-probe-lib-coverage");

beforeEach(() => {
  lookupCalls = [];
  lookupImpl = async () => ({ address: "127.0.0.1", family: 4 });
  fetchCalls = [];
  fetchImpl = async () => Response.json({ maw: true, node: "default-node" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), signal: init?.signal ?? null });
    return fetchImpl(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

describe("src/lib/peers/probe classifiers and formatting", () => {
  test("classifies HTTP, DNS, refused, timeout, TLS, and unknown failures", () => {
    expect(classifyProbeError(new Response("missing", { status: 404 }))).toBe("HTTP_4XX");
    expect(classifyProbeError(new Response("boom", { status: 503 }))).toBe("HTTP_5XX");
    expect(classifyProbeError({ ok: false, status: 302 })).toBe("UNKNOWN");
    expect(classifyProbeError({ cause: { code: "EAI_NODATA" } })).toBe("DNS");
    expect(classifyProbeError({ code: "ConnectionRefused" })).toBe("REFUSED");
    expect(classifyProbeError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe("TIMEOUT");
    expect(classifyProbeError({ name: "TimeoutError" })).toBe("TIMEOUT");
    expect(classifyProbeError({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe("TLS");
    expect(classifyProbeError(undefined)).toBe("UNKNOWN");

    expect(PROBE_EXIT_CODES.DNS).toBe(3);
    expect(PROBE_EXIT_CODES.TIMEOUT).toBe(5);
    expect(PROBE_EXIT_CODES.HTTP_5XX).toBe(6);
  });

  test("validates maw handshake shapes and formats actionable hints", () => {
    expect(isValidMawHandshake(true)).toBe(true);
    expect(isValidMawHandshake({ schema: "1" })).toBe(true);
    expect(isValidMawHandshake({ schema: "" })).toBe(false);
    expect(isValidMawHandshake({})).toBe(false);
    expect(isValidMawHandshake("yes")).toBe(false);
    expect(isValidMawHandshake(false)).toBe(false);

    const mdns = { code: "DNS" as const, message: "query ENOTIMP white.local", at: "now" };
    expect(pickHint(mdns)).toContain("avahi-daemon");
    expect(pickHint({ code: "TLS", message: "cert", at: "now" })).toBe(
      "TLS handshake failed. Check cert validity / chain.",
    );

    const formatted = formatProbeError(mdns, "http://white.local:3456/base", "white");
    expect(formatted).toContain("peer handshake failed");
    expect(formatted).toContain("host: white.local:3456");
    expect(formatted).toContain("retry: maw peers probe white");

    expect(formatProbeError(mdns, "not a url", "bad")).toContain("host: not a url");
  });
});

describe("src/lib/peers/probePeer", () => {
  test("returns node, nickname, pubkey, and explicit identity on a modern peer", async () => {
    fetchImpl = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/info") {
        return Response.json({ maw: { schema: "1" }, node: "peer-node", nickname: "Peer Nick" });
      }
      if (path === "/api/identity") {
        return Response.json({ pubkey: "pub-123", oracle: "oracle-x", node: "peer-node" });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await probePeer("http://peer.test:3456/some/path", 25);

    expect(result).toEqual({
      node: "peer-node",
      nickname: "Peer Nick",
      pubkey: "pub-123",
      identity: { oracle: "oracle-x", node: "peer-node" },
    });
    expect(lookupCalls).toEqual(["peer.test"]);
    expect(fetchCalls.map((call) => new URL(call.url).pathname)).toEqual(["/info", "/api/identity"]);
    expect(fetchCalls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  test("uses name fallback, nullable nickname, and default-oracle identity", async () => {
    fetchImpl = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/info") return Response.json({ maw: true, name: "legacy-name", nickname: "" });
      if (path === "/api/identity") return Response.json({ pubkey: "pub-default", node: "legacy-name" });
      return new Response("not found", { status: 404 });
    };

    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toEqual({
      node: "legacy-name",
      nickname: null,
      pubkey: "pub-default",
      identity: { oracle: "mawjs", node: "legacy-name" },
    });
    expect(lookupCalls).toEqual([]);
  });

  test("keeps a successful /info probe when identity is absent or malformed", async () => {
    fetchImpl = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/info") return Response.json({ maw: true, node: "legacy", nickname: "Legacy Peer" });
      return new Response("missing", { status: 404 });
    };

    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toEqual({
      node: "legacy",
      nickname: "Legacy Peer",
    });

    fetchImpl = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/info") return Response.json({ maw: true, node: "legacy" });
      return new Response("not-json");
    };

    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toEqual({
      node: "legacy",
      nickname: null,
    });
  });

  test("returns structured failures for DNS, HTTP, invalid JSON, missing maw, and missing node", async () => {
    lookupImpl = async () => {
      const err = new Error("getaddrinfo ENOTFOUND missing.local") as Error & { code: string };
      err.code = "ENOTFOUND";
      throw err;
    };
    const dns = await probePeer("http://missing.local:3456", 25);
    expect(dns).toMatchObject({ node: null, error: { code: "DNS", message: "getaddrinfo ENOTFOUND missing.local" } });
    expect(fetchCalls).toEqual([]);

    lookupImpl = async () => ({ address: "127.0.0.1", family: 4 });
    fetchImpl = async () => new Response("server down", { status: 503 });
    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "HTTP_5XX", message: "HTTP 503 from http://127.0.0.1:3456/info" },
    });

    fetchImpl = async () => new Response("not-json");
    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "BAD_BODY", message: "/info body was not valid JSON" },
    });

    fetchImpl = async () => Response.json({ node: "not-maw" });
    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "BAD_BODY", message: '/info response missing valid "maw" handshake field' },
    });

    fetchImpl = async () => Response.json({ maw: true, nickname: "nameless" });
    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "BAD_BODY", message: '/info response had neither "node" nor "name" string' },
    });
  });

  test("classifies fetch throws and uses fallback text for non-Error throws", async () => {
    fetchImpl = async () => {
      const err = new Error("connect ECONNREFUSED") as Error & { cause: { code: string } };
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    };
    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "REFUSED", message: "connect ECONNREFUSED" },
    });

    fetchImpl = async () => {
      throw { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
    };
    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "TLS", message: "fetch http://127.0.0.1:3456/info failed" },
    });

    const invalid = await probePeer("not a url", 25);
    expect(invalid.node).toBeNull();
    expect(invalid.error?.code).toBe("UNKNOWN");
    expect(invalid.error?.message).toContain("/info");
    expect(invalid.error?.message).toContain("not a url");
  });

  test("timer callbacks abort /info failures and best-effort identity fetches", async () => {
    globalThis.setTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
      if (typeof fn === "function") fn(...args as []);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    fetchImpl = async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      const err = new Error("aborted by timer") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    };

    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toMatchObject({
      node: null,
      error: { code: "TIMEOUT", message: "aborted by timer" },
    });

    fetchImpl = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/info") return Response.json({ maw: true, node: "timer-ok" });
      expect(init?.signal?.aborted).toBe(true);
      const err = new Error("identity timer") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    };

    await expect(probePeer("http://127.0.0.1:3456", 25)).resolves.toEqual({
      node: "timer-ok",
      nickname: null,
    });
  });
});
