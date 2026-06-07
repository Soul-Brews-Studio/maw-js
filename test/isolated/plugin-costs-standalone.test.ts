import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

let config: Record<string, unknown> = { host: "local", port: 4242 };
let fetchCalls: string[] = [];
let responseBody = "";
let responseOk = true;
let responseStatus = 200;
let responseStatusText = "OK";
let fetchError: Error | null = null;

class MockUserError extends Error {
  readonly isUserError = true;
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

function parseFlags(args: string[], spec: Record<string, unknown>) {
  const out: Record<string, unknown> & { _: string[] } = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-j") {
      out["--json"] = true;
    } else if (arg === "--json") {
      out["--json"] = true;
    } else if (arg === "--daily") {
      const raw = args[++i];
      out["--daily"] = spec["--daily"] === Number ? Number(raw) : raw;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

const sdkMock = {
  loadConfig: () => config,
  parseFlags,
  UserError: MockUserError,
  sparkline: (values: number[], hadActivity?: boolean[]) =>
    values.map((value, index) => hadActivity?.[index] === false ? "░" : value > 0 ? "█" : "▁").join(""),
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

const { default: costsHandler, command } = await import("../../src/vendor/mpr-plugins/costs/index.ts");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  config = { host: "local", port: 4242 };
  fetchCalls = [];
  responseBody = JSON.stringify({ agents: [], total: { agents: 0, sessions: 0, tokens: 0, cost: 0 } });
  responseOk = true;
  responseStatus = 200;
  responseStatusText = "OK";
  fetchError = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (fetchError) throw fetchError;
    return {
      ok: responseOk,
      status: responseStatus,
      statusText: responseStatusText,
      text: async () => responseBody,
    } as Response;
  }) as typeof fetch;
});

describe("costs plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({ plugin: "costs", files: ["index.ts", "impl.ts"] });

    expect(command).toMatchObject({ name: "costs" });
    expect(imports.map((record) => record.spec)).toEqual(expect.arrayContaining(["maw-js/sdk"]));
  });

  test("default CLI view fetches aggregate costs from the configured maw server", async () => {
    responseBody = JSON.stringify({
      agents: [{ name: "codex-5", totalTokens: 1234, estimatedCost: 1.23, sessions: 2, turns: 9, lastActive: "2026-06-07T00:00:00Z" }],
      total: { agents: 1, sessions: 2, tokens: 1234, cost: 1.23 },
    });

    const result = await costsHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["http://localhost:4242/api/costs"]);
    expect(result.output).toContain("COST TRACKING");
    expect(result.output).toContain("codex-5");
    expect(result.output).toContain("$1.23");
  });

  test("bare --daily injects the default 7 day window and can render JSON", async () => {
    responseBody = JSON.stringify({
      window: 7,
      buckets: ["2026-06-07"],
      agents: [],
      total: { cost: 0, agents: 0 },
    });

    const result = await costsHandler({ source: "cli", args: ["--daily", "--json"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["http://localhost:4242/api/costs/daily?days=7"]);
    expect(result.output).toContain('"window": 7');
  });

  test("API daily args use numeric days and text daily output uses SDK sparkline", async () => {
    config = { host: "maw.local", port: 5151 };
    responseBody = JSON.stringify({
      window: 3,
      buckets: ["2026-06-05", "2026-06-06", "2026-06-07"],
      agents: [{ name: "oracle", dailyCosts: [0, 0.5, 1], totalCost: 1.5, hadActivity: [false, true, true] }],
      total: { cost: 1.5, agents: 1 },
    });

    const result = await costsHandler({ source: "api", args: { daily: true, days: "3" } } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls).toEqual(["http://maw.local:5151/api/costs/daily?days=3"]);
    expect(result.output).toContain("DAILY COSTS");
    expect(result.output).toContain("░██");
  });

  test("network failures return user-facing serve guidance", async () => {
    fetchError = new Error("ECONNREFUSED");

    const result = await costsHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot reach maw server");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
