/** Targeted isolated coverage for src/vendor/mpr-plugins/costs/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type MockConfig = { host: string; port: number };

const config: MockConfig = { host: "local", port: 3456 };
const originalLog = console.log;
const originalFetch = globalThis.fetch;

let logs: string[] = [];
let fetchCalls: string[] = [];
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

const {
  cmdCosts,
  cmdCostsDaily,
} = await import("../../src/vendor/mpr-plugins/costs/impl.ts?costs-impl-coverage");

function stdout(): string {
  return logs.join("\n");
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

function unreadableResponse(status: number, statusText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => {
      throw new Error("body stream failed");
    },
  } as unknown as Response;
}

function emptyCostsResponse() {
  return {
    agents: [],
    total: { agents: 0, sessions: 0, tokens: 0, cost: 0 },
  };
}

function emptyDailyResponse(days: number) {
  return {
    window: days,
    buckets: [],
    agents: [],
    total: { cost: 0, agents: 0 },
  };
}

beforeEach(() => {
  config.host = "local";
  config.port = 3456;
  logs = [];
  fetchCalls = [];
  fetchImpl = async () => jsonResponse(emptyCostsResponse());
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push(String(input));
    return fetchImpl(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
});

describe("costs impl isolated coverage", () => {
  test("cmdCosts distinguishes network, status, body, JSON, and API error paths", async () => {
    fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(cmdCosts()).rejects.toThrow("cannot reach maw server");
    expect(fetchCalls.at(-1)).toBe("http://localhost:3456/api/costs");

    config.host = "maw.remote";
    config.port = 4567;
    fetchImpl = async () => textResponse("upstream unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    });
    await expect(cmdCosts()).rejects.toThrow(
      "maw server returned 503 Service Unavailable: upstream unavailable",
    );
    expect(fetchCalls.at(-1)).toBe("http://maw.remote:4567/api/costs");

    fetchImpl = async () => unreadableResponse(404, "Not Found");
    await expect(cmdCosts()).rejects.toThrow("maw server returned 404 Not Found");

    fetchImpl = async () => textResponse("<html>not json</html>");
    await expect(cmdCosts()).rejects.toThrow(
      "maw server returned non-JSON response: <html>not json</html>",
    );

    fetchImpl = async () => jsonResponse({ error: "cost index exploded", agents: [], total: {} });
    await expect(cmdCosts()).rejects.toThrow("cost index exploded");
  });

  test("cmdCosts renders empty, colored, truncated, and formatted aggregate rows", async () => {
    fetchImpl = async () => jsonResponse(emptyCostsResponse());

    await cmdCosts();
    expect(stdout()).toContain("no session data found");

    const longName = "yellow-agent-with-a-very-long-display-name";
    fetchImpl = async () => jsonResponse({
      agents: [
        {
          name: "green-agent",
          totalTokens: 12,
          estimatedCost: 0.5,
          sessions: 1,
          turns: 2,
        },
        {
          name: longName,
          totalTokens: 1_500,
          estimatedCost: 1.25,
          sessions: 3,
          turns: 4,
          lastActive: "2026-05-18T01:02:03.000Z",
        },
        {
          name: "red-agent",
          totalTokens: 2_500_000,
          estimatedCost: 11,
          sessions: 5,
          turns: 6,
          lastActive: "2026-05-17T01:02:03.000Z",
        },
        {
          name: "billion-agent",
          totalTokens: 3_600_000_000,
          estimatedCost: 0.01,
          sessions: 7,
          turns: 8,
        },
      ],
      total: { agents: 4, sessions: 16, tokens: 3_602_501_512, cost: 51.76 },
    });

    logs = [];
    await cmdCosts();

    const out = stdout();
    expect(out).toContain("COST TRACKING");
    expect(out).toContain("(4 agents, 16 sessions)");
    expect(out).toContain("green-agent");
    expect(out).toContain("$0.50");
    expect(out).toContain("—");
    expect(out).toContain(`${longName.slice(0, 27)}…`);
    expect(out).toContain("1.5K");
    expect(out).toContain("2026-05-18");
    expect(out).toContain("2.5M");
    expect(out).toContain("3.6B");
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("\x1b[33m");
    expect(out).toContain("\x1b[31m");
    expect(out).toContain("TOTAL");
    expect(out).toContain("$51.76");

    fetchImpl = async () => jsonResponse({
      agents: [{ name: "one", totalTokens: 999, estimatedCost: 0, sessions: 1, turns: 1 }],
      total: { agents: 1, sessions: 1, tokens: 999, cost: 9.99 },
    });
    logs = [];
    await cmdCosts();
    expect(stdout()).toContain("$9.99");
    expect(stdout()).toContain("\x1b[32m");

    fetchImpl = async () => jsonResponse({
      agents: [{ name: "one", totalTokens: 1_000_000, estimatedCost: 0, sessions: 1, turns: 1 }],
      total: { agents: 1, sessions: 1, tokens: 1_000_000, cost: 10.01 },
    });
    logs = [];
    await cmdCosts();
    expect(stdout()).toContain("$10.01");
    expect(stdout()).toContain("\x1b[33m");
  });

  test("cmdCostsDaily distinguishes network, status, body, JSON, and API error paths", async () => {
    fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(cmdCostsDaily(7, false)).rejects.toThrow("cannot reach maw server");
    expect(fetchCalls.at(-1)).toBe("http://localhost:3456/api/costs/daily?days=7");

    fetchImpl = async () => textResponse("daily failed", {
      status: 500,
      statusText: "Internal Server Error",
    });
    await expect(cmdCostsDaily(8, false)).rejects.toThrow(
      "maw server returned 500 Internal Server Error: daily failed",
    );

    fetchImpl = async () => unreadableResponse(418, "I'm a Teapot");
    await expect(cmdCostsDaily(9, false)).rejects.toThrow("maw server returned 418 I'm a Teapot");

    fetchImpl = async () => textResponse("not daily json");
    await expect(cmdCostsDaily(10, false)).rejects.toThrow(
      "maw server returned non-JSON response: not daily json",
    );

    fetchImpl = async () => jsonResponse({ error: "daily index exploded" });
    await expect(cmdCostsDaily(11, false)).rejects.toThrow("daily index exploded");
  });

  test("cmdCostsDaily prints raw JSON before table rendering when requested", async () => {
    config.host = "remote-host";
    config.port = 7777;
    const payload = {
      window: 14,
      buckets: ["2026-05-18"],
      agents: [{
        name: "json-agent",
        dailyCosts: [1.23],
        totalCost: 1.23,
        hadActivity: [true],
      }],
      total: { cost: 1.23, agents: 1 },
    };
    fetchImpl = async () => jsonResponse(payload);

    await cmdCostsDaily(14, true);

    expect(fetchCalls).toEqual(["http://remote-host:7777/api/costs/daily?days=14"]);
    expect(JSON.parse(logs[0] ?? "")).toEqual(payload);
    expect(stdout()).not.toContain("DAILY COSTS");
  });

  test("cmdCostsDaily renders empty and tabular daily views with sparklines and totals", async () => {
    fetchImpl = async () => jsonResponse(emptyDailyResponse(5));

    await cmdCostsDaily(5, false);
    expect(stdout()).toContain("no activity in the last 5 days");

    fetchImpl = async () => jsonResponse({
      window: 1,
      buckets: ["2026-05-18"],
      agents: [{
        name: "dated-agent",
        dailyCosts: [2],
        totalCost: 2,
        hadActivity: [true],
      }],
      total: { cost: 2, agents: 1 },
    });

    logs = [];
    await cmdCostsDaily(1, false);
    expect(stdout()).toContain("(1d ending 2026-05-18)");

    const longName = "daily-agent-with-a-very-long-display-name";
    fetchImpl = async () => jsonResponse({
      window: 3,
      buckets: [],
      agents: [
        {
          name: longName,
          dailyCosts: [0, 0, 0],
          totalCost: 0,
          hadActivity: [true, true, true],
        },
        {
          name: "short",
          dailyCosts: [0, 2, 4],
          totalCost: 6,
          hadActivity: [true, false, true],
        },
      ],
      total: { cost: 6, agents: 2 },
    });

    logs = [];
    await cmdCostsDaily(3, false);

    const out = stdout();
    expect(out).toContain("DAILY COSTS");
    expect(out).toContain("(3d ending )");
    expect(out).toContain(`${longName.slice(0, 27)}…`);
    expect(out).toContain("▁▁▁");
    expect(out).toContain("short");
    expect(out).toContain("▁░█");
    expect(out).toContain("$6.00");
    expect(out).toContain("TOTAL");
    expect(out).toContain("░▅█");
  });
});
