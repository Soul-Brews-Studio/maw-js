import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let config: Record<string, unknown> = { avengers: "http://avengers.local" };
let fetchQueue: Array<unknown> = [];
let fetchError: Error | null = null;
let fetchCalls: Array<{ url: string; timeout?: number }> = [];
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalFetch = globalThis.fetch;
const realDateNow = Date.now;

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

const { cmdAvengers } = await import("../../src/vendor/mpr-plugins/avengers/impl.ts?avengers-impl-coverage");

function installFetch() {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const timeout = init?.signal && "reason" in init.signal ? undefined : undefined;
    fetchCalls.push({ url, timeout });
    if (fetchError) throw fetchError;
    const body = fetchQueue.length > 0 ? fetchQueue.shift() : [];
    return {
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  config = { avengers: "http://avengers.local" };
  fetchQueue = [];
  fetchError = null;
  fetchCalls = [];
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  Date.now = realDateNow;
  installFetch();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
  Date.now = realDateNow;
});

describe("avengers impl isolated coverage", () => {
  test("requires avengers config before dispatching", async () => {
    config = {};

    await expect(cmdAvengers("status")).rejects.toThrow("Avengers not configured");
    expect(fetchCalls).toEqual([]);
  });

  test("renders help for unknown subcommands", async () => {
    await cmdAvengers("wat");

    const out = logs.join("\n");
    expect(out).toContain("maw avengers");
    expect(out).toContain("maw avengers status");
    expect(out).toContain("maw avengers health");
    expect(fetchCalls).toEqual([]);
  });

  test("status/all renders account arrays and object fallback", async () => {
    fetchQueue = [
      [
        { name: "green", remaining: 80, limit: 100 },
        { email: "warn@example.test", requests_remaining: 15, requests_limit: 50 },
        { id: "unknown-limit", remaining: "?", limit: 0 },
      ],
      { ok: true, nested: { count: 2 } },
    ];

    await cmdAvengers("status");
    await cmdAvengers("all");

    const out = logs.join("\n");
    expect(fetchCalls.map(c => c.url)).toEqual([
      "http://avengers.local/all",
      "http://avengers.local/all",
    ]);
    expect(out).toContain("Avengers Status");
    expect(out).toContain("green");
    expect(out).toContain("80/100 (80%)");
    expect(out).toContain("warn@example.test");
    expect(out).toContain("15/50 (30%)");
    expect(out).toContain("unknown-limit");
    expect(out).toContain('"nested"');
  });

  test("best and traffic render JSON responses", async () => {
    fetchQueue = [{ name: "best", remaining: 99 }, { total: 123, rolling: [1, 2] }];

    await cmdAvengers("best");
    await cmdAvengers("traffic");

    const out = logs.join("\n");
    expect(fetchCalls.map(c => c.url)).toEqual([
      "http://avengers.local/best",
      "http://avengers.local/traffic-stats",
    ]);
    expect(out).toContain("Best Account");
    expect(out).toContain('"name": "best"');
    expect(out).toContain("Traffic Stats");
    expect(out).toContain('"total": 123');
  });

  test("health reports online count and offline fallback", async () => {
    Date.now = mock(() => 1_000_000) as unknown as typeof Date.now;
    fetchQueue = [[{ name: "one" }, { name: "two" }]];

    await cmdAvengers("health");
    fetchError = new Error("down");
    await cmdAvengers("health");

    const out = logs.join("\n");
    expect(fetchCalls.map(c => c.url)).toEqual([
      "http://avengers.local/all",
      "http://avengers.local/all",
    ]);
    expect(out).toContain("Avengers");
    expect(out).toContain("online");
    expect(out).toContain("2 accounts");
    expect(out).toContain("offline");
  });

  test("network failures are reported for status, best, and traffic", async () => {
    fetchError = new Error("ECONNREFUSED");

    await cmdAvengers("status");
    await cmdAvengers("best");
    await cmdAvengers("traffic");

    const err = errors.join("\n");
    expect(err).toContain("avengers unreachable at http://avengers.local: ECONNREFUSED");
    expect(err).toContain("error");
    expect(fetchCalls.map(c => c.url)).toEqual([
      "http://avengers.local/all",
      "http://avengers.local/best",
      "http://avengers.local/traffic-stats",
    ]);
  });
});
