import { afterEach, describe, expect, test } from "bun:test";

const { maw, print } = await import(`${process.cwd()}/src/core/runtime/sdk.ts?runtime-sdk-${Date.now()}`);

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function installFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(new URL(url), init);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("maw runtime SDK wrappers", () => {
  test("GET wrappers return typed JSON and use documented query/path shapes", async () => {
    const calls = installFetch((url) => {
      if (url.pathname === "/api/identity") {
        return jsonResponse({ node: "m5", version: "v", agents: ["mawjs"], clockUtc: "now", uptime: 1, endpoints: ["/api/identity"], pubkey: "pub" });
      }
      if (url.pathname === "/api/federation/status") {
        return jsonResponse({ localUrl: "http://m5", peers: [{ url: "http://m6" }], totalPeers: 1, reachablePeers: 1 });
      }
      if (url.pathname === "/api/sessions") {
        return jsonResponse([{ name: url.searchParams.get("local") === "true" ? "local-only" : "all", windows: [] }]);
      }
      if (url.pathname === "/api/feed") {
        return jsonResponse([{ id: "evt", type: "message", ts: 1 }]);
      }
      if (url.pathname === "/api/plugins") {
        return jsonResponse({ plugins: [{ name: "demo", version: "1.0.0" }], totalEvents: 2, totalErrors: 0 });
      }
      if (url.pathname === "/api/config") {
        return jsonResponse({ node: "m5" });
      }
      if (url.pathname === "/api/custom") {
        return jsonResponse({ ok: true, method: calls.at(-1)?.init?.method });
      }
      return jsonResponse({ unexpected: url.pathname }, { status: 404, statusText: "Not Found" });
    });

    expect(maw.baseUrl()).toMatch(/^http:\/\/localhost:\d+$/);
    expect(print).toBe(maw.print);
    expect(await maw.identity()).toMatchObject({ node: "m5", agents: ["mawjs"] });
    expect(await maw.federation()).toMatchObject({ totalPeers: 1, reachablePeers: 1 });
    expect(await maw.sessions()).toEqual([{ name: "all", windows: [] }]);
    expect(await maw.sessions(true)).toEqual([{ name: "local-only", windows: [] }]);
    expect(await maw.feed(7)).toEqual([{ id: "evt", type: "message", ts: 1 }]);
    expect(await maw.plugins()).toMatchObject({ totalEvents: 2, totalErrors: 0 });
    expect(await maw.config()).toEqual({ node: "m5" });
    await expect(maw.fetch<{ ok: boolean; method: string }>("/api/custom", { method: "POST", timeout: 123 })).resolves.toEqual({ ok: true, method: "POST" });

    expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
      "/api/identity",
      "/api/federation/status",
      "/api/sessions",
      "/api/sessions?local=true",
      "/api/feed?limit=7",
      "/api/plugins",
      "/api/config",
      "/api/custom",
    ]);
    expect(calls.at(-1)?.init).toMatchObject({ method: "POST" });
  });

  test("GET wrappers fail soft on non-ok responses and thrown fetches", async () => {
    installFetch((url) => {
      if (url.pathname === "/api/identity") return jsonResponse({ error: "down" }, { status: 503, statusText: "Down" });
      throw new Error(`network down for ${url.pathname}`);
    });

    await expect(maw.identity()).resolves.toEqual({
      node: "unknown",
      version: "?",
      agents: [],
      clockUtc: "",
      uptime: 0,
      endpoints: [],
      pubkey: "",
    });
    await expect(maw.federation()).resolves.toEqual({ localUrl: "", peers: [], totalPeers: 0, reachablePeers: 0 });
    await expect(maw.sessions()).resolves.toEqual([]);
    await expect(maw.feed()).resolves.toEqual([]);
    await expect(maw.plugins()).resolves.toEqual({ plugins: [], totalEvents: 0, totalErrors: 0 });
    await expect(maw.config()).resolves.toEqual({});
  });

  test("typed fetch throws with response text and with empty body fallback", async () => {
    installFetch((url) => {
      if (url.pathname === "/api/text-error") return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
      return {
        ok: false,
        status: 418,
        statusText: "Teapot",
        text: () => Promise.reject(new Error("body unavailable")),
      } as Response;
    });

    await expect(maw.fetch("/api/text-error")).rejects.toThrow("502 Bad Gateway: bad gateway");
    await expect(maw.fetch("/api/no-body-error")).rejects.toThrow("418 Teapot");
  });

  test("mutation helpers POST JSON and fail soft when fetch throws", async () => {
    const calls = installFetch((url) => jsonResponse({ ok: true, path: url.pathname }));

    await expect(maw.wake("mawjs", "fix issue")).resolves.toEqual({ ok: true, path: "/api/wake" });
    await expect(maw.sleep("mawjs")).resolves.toEqual({ ok: true, path: "/api/sleep" });
    await expect(maw.send("m5:mawjs", "hello")).resolves.toEqual({ ok: true, path: "/api/send" });

    expect(calls.map((call) => ({ path: new URL(call.url).pathname, method: call.init?.method, body: call.init?.body }))).toEqual([
      { path: "/api/wake", method: "POST", body: JSON.stringify({ target: "mawjs", task: "fix issue" }) },
      { path: "/api/sleep", method: "POST", body: JSON.stringify({ target: "mawjs" }) },
      { path: "/api/send", method: "POST", body: JSON.stringify({ target: "m5:mawjs", text: "hello" }) },
    ]);

    installFetch(() => { throw new Error("offline"); });
    await expect(maw.wake("mawjs")).resolves.toEqual({ ok: false });
    await expect(maw.sleep("mawjs")).resolves.toEqual({ ok: false });
    await expect(maw.send("m5:mawjs", "hello")).resolves.toEqual({ ok: false });
  });
});
