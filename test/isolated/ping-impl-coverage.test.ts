/** Targeted isolated coverage for src/vendor/mpr-plugins/ping/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let configState: Record<string, any> = {};
let cfgTimeoutCalls: string[] = [];
let curlFetchCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
let curlFetchQueue: Array<{ ok: boolean; status?: number; data?: any } | Error> = [];
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/config", () => ({
  loadConfig: () => configState,
  cfgTimeout: (name: string) => {
    cfgTimeoutCalls.push(name);
    return 4321;
  },
}));

mock.module("maw-js/sdk", () => ({
  curlFetch: async (url: string, opts: Record<string, unknown>) => {
    curlFetchCalls.push({ url, opts });
    const next = curlFetchQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? { ok: true, data: {} };
  },
}));

const { cmdPing } = await import("../../src/vendor/mpr-plugins/ping/impl.ts?ping-impl-coverage");

function output() {
  return [...logs, ...errors].join("\n").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  configState = {};
  cfgTimeoutCalls = [];
  curlFetchCalls = [];
  curlFetchQueue = [];
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("ping impl isolated coverage", () => {
  test("defaults missing peer arrays to no configured peers", async () => {
    await cmdPing();

    expect(output()).toContain("no peers configured");
    expect(curlFetchCalls).toEqual([]);
  });

  test("pings all named and legacy peers with success, HTTP failure, and unreachable rows", async () => {
    configState = {
      namedPeers: [{ name: "alpha", url: "http://alpha" }],
      peers: ["http://alpha", "http://legacy-fail", "http://legacy-down"],
    };
    curlFetchQueue = [
      { ok: true, data: { enabled: true, tokenPreview: "tok" } },
      { ok: false, status: 502, data: {} },
      new Error("offline"),
    ];

    await cmdPing();

    expect(curlFetchCalls).toEqual([
      { url: "http://alpha/api/auth/status", opts: { timeout: 4321 } },
      { url: "http://legacy-fail/api/auth/status", opts: { timeout: 4321 } },
      { url: "http://legacy-down/api/auth/status", opts: { timeout: 4321 } },
    ]);
    expect(cfgTimeoutCalls).toEqual(["ping", "ping", "ping"]);
    const plain = output();
    expect(plain).toContain("alpha (http://alpha)");
    expect(plain).toContain("auth: ok (tok)");
    expect(plain).toContain("http://legacy-fail");
    expect(plain).toContain("502");
    expect(plain).toContain("http://legacy-down");
    expect(plain).toContain("unreachable");
  });

  test("pings specific named and legacy nodes, and reports known names for misses", async () => {
    configState = {
      namedPeers: [{ name: "alpha", url: "http://alpha" }],
      peers: ["http://legacy-node"],
    };

    await cmdPing("alpha");
    expect(curlFetchCalls.at(-1)?.url).toBe("http://alpha/api/auth/status");

    await cmdPing("legacy");
    expect(curlFetchCalls.at(-1)?.url).toBe("http://legacy-node/api/auth/status");
    expect(output()).toContain("legacy (http://legacy-node)");

    await expect(cmdPing("ghost")).rejects.toThrow("unknown node \"ghost\"");
    expect(output()).toContain("known: alpha");
  });
});
