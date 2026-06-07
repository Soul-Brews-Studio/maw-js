import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createAvengersApi } from "../src/api/avengers";

const ISO = "2026-05-17T00:00:00.000Z";

function apiWith(options: {
  base?: string;
  fetch?: typeof fetch;
  nowValues?: number[];
} = {}) {
  const urls: string[] = [];
  const timeoutMs: number[] = [];
  const nowValues = [...(options.nowValues ?? [100, 125])];
  const app = new Elysia({ prefix: "/api" }).use(createAvengersApi({
    loadConfig: () => ({ avengers: options.base }) as any,
    fetch: (async (url, init) => {
      urls.push(String(url));
      if ((init as any)?.signal) timeoutMs.push((init as any).signal.ms);
      return options.fetch
        ? await options.fetch(url, init)
        : Response.json({ ok: true });
    }) as typeof fetch,
    nowIso: () => ISO,
    nowMs: () => nowValues.shift() ?? 125,
    timeoutSignal: ((ms: number) => ({ ms }) as any),
  }));
  return { app, urls, timeoutMs };
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

function routeFetch(responses: Record<string, Response | Error>): typeof fetch {
  return (async (url) => {
    const key = String(url).split("/").pop() ?? "";
    const response = responses[key];
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`unexpected ${url}`);
    return response;
  }) as typeof fetch;
}

describe("avengers API default-suite coverage", () => {
  test("default router factory is constructible", () => {
    expect(createAvengersApi()).toBeInstanceOf(Elysia);
  });

  test("default clock and timeout helpers work when only config and fetch are injected", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createAvengersApi({
      loadConfig: () => ({ avengers: "http://avengers.local" }) as any,
      fetch: (async () => Response.json([{ id: "a" }])) as typeof fetch,
    }));

    let res = await app.handle(new Request("http://local/api/avengers/status"));
    let body = await json(res);
    expect(body.total).toBe(1);
    expect(typeof body.timestamp).toBe("string");

    res = await app.handle(new Request("http://local/api/avengers/health"));
    body = await json(res);
    expect(body).toMatchObject({ configured: true, reachable: true, accounts: 1 });
    expect(typeof body.latency).toBe("number");
  });

  test("reports not configured for status and health without a base URL", async () => {
    const { app, urls } = apiWith();

    let res = await app.handle(new Request("http://local/api/avengers/status"));
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "avengers not configured" });

    res = await app.handle(new Request("http://local/api/avengers/health"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ configured: false, reachable: false });
    expect(urls).toEqual([]);
  });

  test("status proxies all accounts and counts only arrays", async () => {
    const { app, urls, timeoutMs } = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ all: Response.json([{ id: "a" }, { id: "b" }]) }),
    });

    const res = await app.handle(new Request("http://local/api/avengers/status"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      accounts: [{ id: "a" }, { id: "b" }],
      total: 2,
      source: "http://avengers.local",
      timestamp: ISO,
    });
    expect(urls).toEqual(["http://avengers.local/all"]);
    expect(timeoutMs).toEqual([5000]);

    const objectAccounts = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ all: Response.json({ account: "solo" }) }),
    });
    const objectRes = await objectAccounts.app.handle(new Request("http://local/api/avengers/status"));
    expect((await json(objectRes)).total).toBe(0);
  });

  test("status and best surface upstream failures as 502", async () => {
    const statusApp = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ all: new Error("offline") }),
    });
    let res = await statusApp.app.handle(new Request("http://local/api/avengers/status"));
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: "avengers unreachable: offline" });

    const bestApp = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ best: new Error("best down") }),
    });
    res = await bestApp.app.handle(new Request("http://local/api/avengers/best"));
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: "avengers unreachable: best down" });
  });

  test("best proxies the selected account", async () => {
    const { app, urls, timeoutMs } = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ best: Response.json({ account: "nat", remaining: 42 }) }),
    });

    const res = await app.handle(new Request("http://local/api/avengers/best"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ account: "nat", remaining: 42 });
    expect(urls).toEqual(["http://avengers.local/best"]);
    expect(timeoutMs).toEqual([5000]);
  });

  test("traffic combines traffic and speed, tolerating speed failures", async () => {
    const ok = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({
        "traffic-stats": Response.json({ total: 10 }),
        speed: Response.json({ rpm: 3 }),
      }),
    });
    let res = await ok.app.handle(new Request("http://local/api/avengers/traffic"));
    expect(await json(res)).toEqual({ traffic: { total: 10 }, speed: { rpm: 3 }, timestamp: ISO });
    expect(ok.urls).toEqual(["http://avengers.local/traffic-stats", "http://avengers.local/speed"]);

    const speedRejects = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({
        "traffic-stats": Response.json({ total: 10 }),
        speed: new Error("speed down"),
      }),
    });
    res = await speedRejects.app.handle(new Request("http://local/api/avengers/traffic"));
    expect((await json(res)).speed).toBeNull();

    const speedJsonFails = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({
        "traffic-stats": Response.json({ total: 10 }),
        speed: new Response("not json"),
      }),
    });
    res = await speedJsonFails.app.handle(new Request("http://local/api/avengers/traffic"));
    expect((await json(res)).speed).toBeNull();
  });

  test("traffic surfaces primary traffic failures as 502", async () => {
    const { app } = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({
        "traffic-stats": new Error("traffic down"),
        speed: Response.json({ rpm: 3 }),
      }),
    });

    const res = await app.handle(new Request("http://local/api/avengers/traffic"));

    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: "avengers unreachable: traffic down" });
  });

  test("health reports latency, reachable status, account count, and catch fallback", async () => {
    const reachable = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ all: Response.json([{ id: "a" }], { status: 202 }) }),
      nowValues: [10, 37],
    });
    let res = await reachable.app.handle(new Request("http://local/api/avengers/health"));
    expect(await json(res)).toEqual({
      configured: true,
      reachable: true,
      latency: 27,
      accounts: 1,
      url: "http://avengers.local",
    });
    expect(reachable.timeoutMs).toEqual([3000]);

    const nonArray = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ all: Response.json({ account: "solo" }, { status: 503 }) }),
      nowValues: [1, 4],
    });
    res = await nonArray.app.handle(new Request("http://local/api/avengers/health"));
    expect(await json(res)).toMatchObject({ reachable: false, latency: 3, accounts: 0 });

    const failing = apiWith({
      base: "http://avengers.local",
      fetch: routeFetch({ all: new Error("offline") }),
    });
    res = await failing.app.handle(new Request("http://local/api/avengers/health"));
    expect(await json(res)).toEqual({ configured: true, reachable: false, url: "http://avengers.local" });
  });
});
