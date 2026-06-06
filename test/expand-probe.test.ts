import { beforeEach, describe, expect, mock, test } from "bun:test";

const sdkPath = import.meta.resolve("../src/sdk/index.ts");
const configPath = import.meta.resolve("../src/config.ts");

let nextResponse: any = { ok: true, status: 200, data: { node: "alpha", agents: ["mawjs", 7, "sila"] } };
let nextError: Error | null = null;
let calls: Array<{ url: string; opts: Record<string, unknown> }> = [];

mock.module(configPath, () => ({
  cfgTimeout: () => 1234,
}));

mock.module(sdkPath, () => ({
  curlFetch: async (url: string, opts: Record<string, unknown>) => {
    calls.push({ url, opts });
    if (nextError) throw nextError;
    return nextResponse;
  },
}));

const { fetchExpandProbeIdentity } = await import("../src/commands/shared/expand-probe.ts?probe-test");

beforeEach(() => {
  nextResponse = { ok: true, status: 200, data: { node: "alpha", agents: ["mawjs", 7, "sila"] } };
  nextError = null;
  calls = [];
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
