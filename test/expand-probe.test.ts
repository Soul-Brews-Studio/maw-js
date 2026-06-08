import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "./helpers/mock-config";

const sdkPath = import.meta.resolve("../src/sdk/index.ts");
const configPath = import.meta.resolve("../src/config.ts");

// Capture real implementations before mocking (#2474 — mockActive gate prevents
// live-binding contamination of sdk.curlFetch → curl-fetch.ts exports).
const _rSdk = await import(sdkPath as any);
const _rConfig = await import(configPath as any);
const realCurlFetch = _rSdk.curlFetch as typeof _rSdk.curlFetch;
const realConfig = { ..._rConfig };

let mockActive = false;
let nextResponse: any = { ok: true, status: 200, data: { node: "alpha", agents: ["mawjs", 7, "sila"] } };
let nextError: Error | null = null;
let calls: Array<{ url: string; opts: Record<string, unknown> }> = [];

mock.module(configPath, () => ({
  ...realConfig,
  ...mockConfigModule(() => ({ node: "alpha", federationToken: "test-token-16chars!" })),
  cfgTimeout: () => mockActive ? 1234 : (_rConfig as any).cfgTimeout?.(),
}));

mock.module(sdkPath, () => ({
  ..._rSdk,
  curlFetch: async (url: string, opts: Record<string, unknown>) => {
    if (!mockActive) return realCurlFetch(url, opts as any);
    calls.push({ url, opts });
    if (nextError) throw nextError;
    return nextResponse;
  },
}));

const { fetchExpandProbeIdentity } = await import("../src/commands/shared/expand-probe.ts?probe-test");

beforeEach(() => {
  mockActive = true;
  nextResponse = { ok: true, status: 200, data: { node: "alpha", agents: ["mawjs", 7, "sila"] } };
  nextError = null;
  calls = [];
});

afterEach(() => {
  mockActive = false;
  nextError = null;
});

afterAll(() => {
  mockActive = false;
});

describe("fetchExpandProbeIdentity", () => {
  test("reads /api/identity with signed auto identity and normalizes agents", async () => {
    const result = await fetchExpandProbeIdentity("http://alpha.wg:3461/");

    expect(calls).toEqual([{ url: "http://alpha.wg:3461/api/identity", opts: { timeout: 1234, from: "auto" } }]);
    expect(result).toEqual({
      url: "http://alpha.wg:3461/api/identity",
      reachable: true,
      advertisedNode: "alpha",
      agents: ["mawjs", "sila"],
      status: 200,
    });
  });

  test("returns structured unreachable probe data for http failures and throws", async () => {
    nextResponse = { ok: false, status: 503, data: null };
    let result = await fetchExpandProbeIdentity("http://alpha.wg:3461");
    expect(result).toMatchObject({ reachable: false, status: 503, error: "http 503" });

    nextError = new Error("connect timeout\nstack");
    result = await fetchExpandProbeIdentity("http://alpha.wg:3461");
    expect(result).toMatchObject({ reachable: false, status: 0, error: "connect timeout" });
  });
});
