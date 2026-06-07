/**
 * Targeted isolated coverage for src/vendor/mpr-plugins/zenoh-scout/index.ts.
 *
 * The index is mostly argument routing and output shaping. We mock config,
 * the zenoh impl, and the discovered-peer helper so this file only exercises
 * index-level behavior without requiring zenoh, daemon HTTP calls, or runtime
 * side effects.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

const implPath = import.meta.resolve("../../src/vendor/mpr-plugins/zenoh-scout/impl");
const discoveredPath = import.meta.resolve("../../src/vendor/mpr-plugins/peers/discovered");
const realZenohImpl = await import("../../src/vendor/mpr-plugins/zenoh-scout/impl");
const realDiscovered = await import("../../src/vendor/mpr-plugins/peers/discovered");

let loadConfigValue: Record<string, unknown> = {};
let loadConfigError: Error | null = null;
let readConfigReturn: Record<string, unknown>;
let formatZenohReturn = "formatted zenoh";
let runZenohResult: Record<string, unknown>;
let runZenohError: Error | null = null;
let discoveredResult: Record<string, unknown>;
let formatDiscoveriesReturn = "formatted discoveries";

let readConfigCalls: Array<Record<string, unknown>> = [];
let formatZenohCalls: Array<Record<string, unknown>> = [];
let runZenohCalls: Array<Record<string, unknown>> = [];
let fetchDiscoveriesCalls: Array<Record<string, unknown>> = [];
let formatDiscoveriesCalls: Array<Record<string, unknown>> = [];

mock.module("maw-js/config", () => ({
  ...mockConfigModule(() => {
    if (loadConfigError) throw loadConfigError;
    return loadConfigValue as any;
  }),
}));

mock.module(implPath, () => ({
  ...realZenohImpl,
  readZenohScoutConfig: (config: Record<string, unknown>) => {
    readConfigCalls.push(config);
    return { ...readConfigReturn };
  },
  formatZenohScoutResult: (result: Record<string, unknown>) => {
    formatZenohCalls.push(result);
    return formatZenohReturn;
  },
  runZenohScout: async (config: Record<string, unknown>) => {
    runZenohCalls.push(config);
    if (runZenohError) throw runZenohError;
    return runZenohResult;
  },
}));

mock.module(discoveredPath, () => ({
  ...realDiscovered,
  fetchDiscoveries: async (opts: Record<string, unknown>) => {
    fetchDiscoveriesCalls.push(opts);
    return discoveredResult;
  },
  formatDiscoveries: (result: Record<string, unknown>) => {
    formatDiscoveriesCalls.push(result);
    return formatDiscoveriesReturn;
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/zenoh-scout/index.ts?zenoh-scout-index-coverage");

function baseScoutConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    locator: "ws://router:10000",
    timeoutMs: 750,
    keyPrefix: "maw/discovery/v1",
    node: "m5",
    oracle: "mawjs",
    apiUrl: "http://m5:3456",
    capabilities: ["pair", "feed", "send"],
    advertise: true,
    ...overrides,
  };
}

beforeEach(() => {
  loadConfigValue = { node: "m5", oracle: "mawjs", zenoh: {} };
  loadConfigError = null;
  readConfigReturn = baseScoutConfig();
  formatZenohReturn = "formatted zenoh";
  runZenohResult = {
    ok: true,
    enabled: true,
    locator: "ws://router:10000",
    keyPrefix: "maw/discovery/v1",
    total: 0,
    peers: [],
  };
  runZenohError = null;
  discoveredResult = {
    ok: true,
    total: 1,
    shown: 1,
    filtered: false,
    peers: [{ zid: "peer-1", oracle: "pulse" }],
  };
  formatDiscoveriesReturn = "formatted discoveries";

  readConfigCalls = [];
  formatZenohCalls = [];
  runZenohCalls = [];
  fetchDiscoveriesCalls = [];
  formatDiscoveriesCalls = [];
});

describe("zenoh-scout plugin index", () => {
  test("exports scout command metadata", () => {
    expect(command).toEqual({
      name: "scout",
      description: "Opt-in Zenoh liveliness discovery provider for maw peers (#1455).",
    });
  });

  test("rejects invalid transport values before running discovery", async () => {
    const result = await handler({
      source: "api",
      args: { transport: "bogus" },
    } as any);

    expect(result).toEqual({
      ok: false,
      error: "invalid_transport",
      output: "usage: maw scout --transport zenoh|scout|both",
    });
    expect(runZenohCalls).toEqual([]);
    expect(fetchDiscoveriesCalls).toEqual([]);
  });

  test("routes api scout requests to discovered peers and uses ctx.writer when present", async () => {
    const writes: string[] = [];
    discoveredResult = {
      ok: true,
      total: 2,
      shown: 2,
      filtered: false,
      peers: [{ zid: "peer-a" }, { zid: "peer-b" }],
    };

    const result = await handler({
      source: "api",
      args: {
        transport: "scout",
        all: "yes",
        limit: 2,
        json: "true",
      },
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(fetchDiscoveriesCalls).toEqual([{ all: true, limit: 2 }]);
    expect(writes).toEqual([JSON.stringify(discoveredResult, null, 2)]);
    expect(result).toEqual({
      ok: true,
      total: 2,
      peers: discoveredResult.peers,
      output: undefined,
    });
    expect(formatDiscoveriesCalls).toEqual([]);
    expect(runZenohCalls).toEqual([]);
  });

  test("returns status output with cli locator override", async () => {
    readConfigReturn = baseScoutConfig({ enabled: true, locator: "ws://base:10000", keyPrefix: "maw/test/v1" });

    const result = await handler({
      source: "cli",
      args: ["--status", "--locator", "ws://override:10000"],
    } as any);

    expect(formatZenohCalls).toEqual([
      {
        ok: true,
        enabled: true,
        locator: "ws://override:10000",
        keyPrefix: "maw/test/v1",
        total: 0,
        peers: [],
        hint: "zenoh-scout enabled; run `maw scout --force` to query now",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      enabled: true,
      locator: "ws://override:10000",
      keyPrefix: "maw/test/v1",
      total: 0,
      peers: [],
      hint: "zenoh-scout enabled; run `maw scout --force` to query now",
      output: "formatted zenoh",
    });
    expect(runZenohCalls).toEqual([]);
  });

  test("returns the opt-in disabled zenoh result without running scout", async () => {
    readConfigReturn = baseScoutConfig({ enabled: false, locator: "ws://disabled:10000", keyPrefix: "maw/disabled/v1" });

    const result = await handler({
      source: "cli",
      args: ["--transport", "zenoh"],
    } as any);

    expect(formatZenohCalls).toEqual([
      {
        ok: true,
        enabled: false,
        locator: "ws://disabled:10000",
        keyPrefix: "maw/disabled/v1",
        total: 0,
        peers: [],
        hint: "zenoh-scout is opt-in; set zenoh.scout.enabled=true or pass --force for a one-shot query",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      enabled: false,
      locator: "ws://disabled:10000",
      keyPrefix: "maw/disabled/v1",
      total: 0,
      peers: [],
      hint: "zenoh-scout is opt-in; set zenoh.scout.enabled=true or pass --force for a one-shot query",
      output: "formatted zenoh",
    });
    expect(runZenohCalls).toEqual([]);
    expect(fetchDiscoveriesCalls).toEqual([]);
  });

  test("merges api overrides into a forced zenoh run and emits json", async () => {
    readConfigReturn = baseScoutConfig({ enabled: false, locator: "ws://base:10000", timeoutMs: 750 });
    runZenohResult = {
      ok: true,
      enabled: true,
      locator: "ws://api:10000",
      keyPrefix: "maw/discovery/v1",
      total: 1,
      peers: [{ zid: "zenoh:1", oracle: "pulse" }],
    };

    const result = await handler({
      source: "api",
      args: {
        force: "on",
        locator: "ws://api:10000",
        timeoutMs: "333",
        advertise: "off",
        json: "true",
      },
    } as any);

    expect(runZenohCalls).toEqual([
      {
        ...baseScoutConfig({ enabled: false, locator: "ws://base:10000", timeoutMs: 750 }),
        enabled: true,
        locator: "ws://api:10000",
        timeoutMs: 333,
        advertise: false,
      },
    ]);
    expect(result).toEqual({
      ...runZenohResult,
      output: JSON.stringify(runZenohResult, null, 2),
    });
  });

  test("combines disabled zenoh and scout discovery output for transport=both", async () => {
    readConfigReturn = baseScoutConfig({ enabled: false, locator: "ws://both:10000", keyPrefix: "maw/both/v1" });
    discoveredResult = {
      ok: true,
      total: 1,
      shown: 1,
      filtered: false,
      peers: [{ zid: "peer-both" }],
    };
    formatZenohReturn = "zenoh disabled summary";
    formatDiscoveriesReturn = "scout discovery summary";

    const result = await handler({
      source: "cli",
      args: ["--transport", "both", "--all", "--limit", "5"],
    } as any);

    expect(fetchDiscoveriesCalls).toEqual([{ all: true, limit: 5 }]);
    expect(formatZenohCalls).toEqual([
      {
        ok: true,
        enabled: false,
        locator: "ws://both:10000",
        keyPrefix: "maw/both/v1",
        total: 0,
        peers: [],
        hint: "zenoh-scout is opt-in; set zenoh.scout.enabled=true or pass --force for a one-shot query",
      },
    ]);
    expect(formatDiscoveriesCalls).toEqual([discoveredResult]);
    expect(result).toEqual({
      ok: true,
      error: undefined,
      output: [
        "zenoh:",
        "  zenoh disabled summary",
        "",
        "scout:",
        "  scout discovery summary",
      ].join("\n"),
    });
    expect(runZenohCalls).toEqual([]);
  });

  test("emits combined json for transport=both when zenoh is forced", async () => {
    readConfigReturn = baseScoutConfig({ enabled: false, locator: "ws://base:10000" });
    runZenohResult = {
      ok: true,
      enabled: true,
      locator: "ws://base:10000",
      keyPrefix: "maw/discovery/v1",
      total: 1,
      peers: [{ zid: "zenoh:1" }],
    };
    discoveredResult = {
      ok: false,
      error: "scout_down",
      total: 0,
      shown: 0,
      filtered: false,
      peers: [],
    };
    const writes: string[] = [];

    const result = await handler({
      source: "api",
      args: { transport: "both", force: "true", json: "true" },
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    const expected = { ok: true, zenoh: runZenohResult, scout: discoveredResult };
    expect(writes).toEqual([JSON.stringify(expected, null, 2)]);
    expect(result).toEqual({ ok: true, error: undefined, output: undefined });
    expect(formatZenohCalls).toEqual([]);
    expect(formatDiscoveriesCalls).toEqual([]);
  });

  test("surfaces thrown errors as command failures", async () => {
    runZenohError = new Error("zenoh exploded");

    const result = await handler({
      source: "cli",
      args: ["--force"],
    } as any);

    expect(result).toEqual({
      ok: false,
      error: "zenoh exploded",
      output: undefined,
    });
  });
});
