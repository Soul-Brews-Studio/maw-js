import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let config: { node?: string } = { node: "m5" };
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchReject = false;
let mkdirCalls: Array<{ path: string; opts?: unknown }> = [];
let appendCalls: Array<{ path: string; data: string }> = [];
const originalFetch = globalThis.fetch;

mock.module("../../src/config", () => ({
  loadConfig: () => config,
}));

mock.module("fs/promises", () => ({
  mkdir: async (path: string, opts?: unknown) => {
    mkdirCalls.push({ path, opts });
  },
  appendFile: async (path: string, data: string) => {
    appendCalls.push({ path, data });
  },
}));

mock.module("os", () => ({
  homedir: () => "/home/tester",
  hostname: () => "test-host",
}));

const mod = await import("../../src/commands/shared/comm-log-feed.ts?comm-log-feed-more-coverage");

beforeEach(() => {
  config = { node: "m5" };
  fetchCalls = [];
  fetchReject = false;
  mkdirCalls = [];
  appendCalls = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return fetchReject ? Promise.reject(new Error("offline")) : Promise.resolve(new Response("ok"));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("comm log feed more coverage", () => {
  test("logMessage writes normalized JSONL and truncates long messages", async () => {
    const long = "x".repeat(520);

    await mod.logMessage("oracle", "white:target", long, "direct");

    expect(mkdirCalls[0].path).toBe("/home/tester/.maw");
    expect(appendCalls[0].path).toBe("/home/tester/.maw/maw-log.jsonl");
    const parsed = JSON.parse(appendCalls[0].data.trim());
    expect(parsed.from).toBe("m5:oracle");
    expect(parsed.to).toBe("white:target");
    expect(parsed.msg).toHaveLength(500);
    expect(parsed.host).toBe("test-host");
    expect(parsed.route).toBe("direct");
  });

  test("logMessage rejects missing node before writing", async () => {
    config = {};
    await expect(mod.logMessage("m5:oracle", "target", "msg", "route")).rejects.toThrow("config.node is required");
    expect(appendCalls).toEqual([]);
  });

  test("emitFeed posts optional data and swallows fetch failures", async () => {
    mod.emitFeed("message", "oracle", "m5", "hello", 3456, { route: "direct" });
    await Promise.resolve();
    expect(fetchCalls[0].url).toBe("http://localhost:3456/api/feed");
    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body).toMatchObject({ event: "message", oracle: "oracle", host: "m5", message: "hello", data: { route: "direct" } });

    fetchReject = true;
    expect(() => mod.emitFeed("message", "oracle", "m5", "hello", 3456)).not.toThrow();
    await Promise.resolve();
  });

  test("emitMessageLifecycle builds and posts typed lifecycle events", async () => {
    mod.emitMessageLifecycle({
      direction: "outgoing",
      phase: "delivered",
      from: "m5:sender",
      to: "white:receiver",
      route: "maw",
      message: "hello",
    }, 4567);
    await Promise.resolve();

    expect(fetchCalls[0].url).toBe("http://localhost:4567/api/feed");
    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.event).toBe("MessageDeliver");
    expect(body.oracle).toBe("sender");
    expect(body.host).toBe("m5");
  });

  test("emitMessageLifecycle swallows feed delivery failures", async () => {
    fetchReject = true;

    expect(() => mod.emitMessageLifecycle({
      direction: "outgoing",
      phase: "queued",
      from: "m5:sender",
      to: "white:receiver",
      route: "inbox",
      message: "hello",
    }, 4567)).not.toThrow();
    await Promise.resolve();

    expect(fetchCalls[0].url).toBe("http://localhost:4567/api/feed");
  });
});
