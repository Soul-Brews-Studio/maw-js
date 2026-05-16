import { describe, expect, test } from "bun:test";
import { join } from "path";
import { loadManifestFromDir } from "../src/plugin/manifest";
import { validateConfig } from "../src/config/validate-ext";
import {
  discoveryKey,
  parseDiscoveryKey,
  readZenohScoutConfig,
  runZenohScout,
  type ZenohApi,
} from "../src/vendor/mpr-plugins/zenoh-scout/impl";
import { ZenohScoutTransport } from "../src/transports/zenoh-scout";
import { discoveryTransport } from "../src/transports";

describe("zenoh-scout plugin (#1455)", () => {
  test("manifest is valid and exposes opt-in cli/api surfaces", () => {
    const loaded = loadManifestFromDir(join(import.meta.dir, "../src/vendor/mpr-plugins/zenoh-scout"));
    expect(loaded?.manifest.name).toBe("zenoh-scout");
    expect(loaded?.manifest.cli?.command).toBe("scout");
    expect(loaded?.manifest.cli?.aliases).toContain("zenoh-scout");
    expect(loaded?.manifest.api?.path).toBe("/api/peers/discovered");
    expect(loaded?.manifest.capabilities).toEqual(expect.arrayContaining(["peer:scout", "net:websocket"]));
  });

  test("config validator preserves nested zenoh.scout options", () => {
    const cfg = validateConfig({
      node: "m5",
      oracle: "mawjs",
      zenoh: {
        locator: "ws://router:10000",
        scout: {
          enabled: true,
          locator: "ws://scout:10000",
          timeoutMs: 1234,
          keyPrefix: "maw/test/v1",
        },
      },
      discovery: {
        transport: "both",
      },
    });

    expect(cfg.zenoh?.locator).toBe("ws://router:10000");
    expect(cfg.zenoh?.scout?.enabled).toBe(true);
    expect(cfg.zenoh?.scout?.locator).toBe("ws://scout:10000");
    expect(cfg.zenoh?.scout?.timeoutMs).toBe(1234);
    expect(cfg.zenoh?.scout?.keyPrefix).toBe("maw/test/v1");
    expect(cfg.discovery?.transport).toBe("both");
  });

  test("discovery transport treats zenoh-scout as a plugin upgrade that can be disabled", () => {
    expect(discoveryTransport({
      zenoh: { scout: { enabled: true } },
    })).toBe("both");
    expect(discoveryTransport({
      zenoh: { scout: { enabled: true } },
      disabledPlugins: ["zenoh-scout"],
    })).toBe("scout");
    expect(discoveryTransport({
      discovery: { transport: "both" },
      disabledPlugins: ["zenoh-scout"],
    })).toBe("scout");
    expect(discoveryTransport({
      discovery: { transport: "zenoh" },
      disabledPlugins: ["zenoh-scout"],
    })).toBe("off");
  });

  test("discovery keys round-trip into maw peer discovery rows", () => {
    const cfg = readZenohScoutConfig({
      node: "m5",
      oracle: "mawjs",
      port: 3456,
      zenoh: { scout: { enabled: true, keyPrefix: "maw/test/v1" } },
    });
    const key = discoveryKey(cfg);
    const row = parseDiscoveryKey(key, "maw/test/v1", new Date("2026-05-15T00:00:00.000Z"));

    expect(row).toMatchObject({
      node: "m5",
      oracle: "mawjs",
      host: "m5:3456",
      locators: ["http://m5:3456"],
      capabilities: ["pair", "feed", "send"],
      firstSeen: "2026-05-15T00:00:00.000Z",
      transport: "zenoh",
    });
    expect(row?.zid).toStartWith("zenoh:");
  });

  test("queries zenoh liveliness via injectable zenoh-ts API and skips self", async () => {
    const local = readZenohScoutConfig({ node: "m5", oracle: "mawjs", port: 3456, zenoh: { scout: { enabled: true } } });
    const remote = readZenohScoutConfig({ node: "white", oracle: "pulse", port: 4567, zenoh: { scout: { enabled: true } } });
    const remoteKey = discoveryKey(remote);
    const localKey = discoveryKey(local);
    const calls: string[] = [];

    class FakeConfig {
      constructor(public locator: string, public timeoutMs?: number) {}
    }
    class FakeKeyExpr {
      constructor(public key: string) {}
      toString() { return this.key; }
    }

    const fakeSession = {
      liveliness() {
        return {
          async declareToken(key: FakeKeyExpr) {
            calls.push(`declare:${key}`);
            return { async undeclare() { calls.push("undeclare"); } };
          },
          async get(key: FakeKeyExpr) {
            calls.push(`get:${key}`);
            return (async function* () {
              yield { result: () => ({ keyexpr: () => ({ toString: () => remoteKey }) }) };
              yield { result: () => ({ keyexpr: () => ({ toString: () => localKey }) }) };
            })();
          },
        };
      },
      async close() { calls.push("close"); },
    };

    const fakeZenoh: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      Session: { open: async () => fakeSession },
      Duration: { milliseconds: { of: (ms: number) => ms } },
    };

    const result = await runZenohScout(local, {
      importZenoh: async () => fakeZenoh,
      now: () => new Date("2026-05-15T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.peers[0]).toMatchObject({
      node: "white",
      oracle: "pulse",
      locators: ["http://white:4567"],
      transport: "zenoh",
    });
    expect(calls).toEqual([
      `declare:${localKey}`,
      "get:maw/discovery/v1/**",
      "undeclare",
      "close",
    ]);
  });

  test("missing zenoh bridge is reported as actionable unavailability", async () => {
    const cfg = readZenohScoutConfig({ node: "m5", oracle: "mawjs", zenoh: { scout: { enabled: true } } });
    const result = await runZenohScout(cfg, {
      importZenoh: async () => {
        throw new Error("Cannot connect to remote API");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("zenoh_unavailable");
    expect(result.hint).toContain("start zenohd");
  });

  test("zenoh-ts runtime or wasm init failures are reported separately from bridge unavailability", async () => {
    const cfg = readZenohScoutConfig({ node: "m5", oracle: "mawjs", zenoh: { scout: { enabled: true } } });
    const result = await runZenohScout(cfg, {
      importZenoh: async () => {
        throw new Error("wasm.__wbindgen_start is not a function");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("zenoh_runtime_unsupported");
    expect(result.hint).toContain("zenoh-ts failed to initialize in this runtime");
  });

  test("ZenohScoutTransport feeds router-style discovered peers without sending or pairing", async () => {
    const local = readZenohScoutConfig({ node: "m5", oracle: "mawjs", port: 3456, zenoh: { scout: { enabled: true } } });
    const remote = readZenohScoutConfig({ node: "clinic", oracle: "pulse", port: 4567, zenoh: { scout: { enabled: true } } });
    const remoteKey = discoveryKey(remote);

    class FakeConfig {
      constructor(public locator: string, public timeoutMs?: number) {}
    }
    class FakeKeyExpr {
      constructor(public key: string) {}
      toString() { return this.key; }
    }

    const fakeSession = {
      liveliness() {
        return {
          async declareToken() {
            return { async undeclare() {} };
          },
          async get() {
            return (async function* () {
              yield { result: () => ({ keyexpr: () => ({ toString: () => remoteKey }) }) };
            })();
          },
        };
      },
      async close() {},
    };

    const fakeZenoh: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      Session: { open: async () => fakeSession },
      Duration: { milliseconds: { of: (ms: number) => ms } },
    };

    const transport = new ZenohScoutTransport({
      ...local,
      enabled: true,
      pollMs: 60_000,
      importZenoh: async () => fakeZenoh,
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    await transport.connect();
    try {
      expect(transport.connected).toBe(true);
      expect(transport.canReach({ oracle: "pulse", host: "clinic" })).toBe(false);
      expect(await transport.send({ oracle: "pulse", host: "clinic" }, "hello")).toBe(false);
      expect(transport.listPeers()).toEqual([
        expect.objectContaining({
          zid: expect.stringContaining("zenoh:"),
          node: "clinic",
          oracle: "pulse",
          host: "clinic:4567",
          locators: ["http://clinic:4567"],
          capabilities: ["pair", "feed", "send"],
          paired: false,
          lastSeen: Date.parse("2026-05-16T00:00:00.000Z"),
        }),
      ]);
    } finally {
      await transport.disconnect();
    }
  });
});
