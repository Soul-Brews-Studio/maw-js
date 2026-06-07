import { describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { loadManifestFromDir } from "../../src/plugin/manifest";
import { validateConfig } from "../../src/config/validate-ext";
import {
  discoveryKey,
  parseDiscoveryKey,
  readZenohScoutConfig,
  runZenohScout,
  formatZenohScoutResult,
  keyexprFromReply,
  type ZenohApi,
} from "../../src/vendor/mpr-plugins/zenoh-scout/impl";
import { ZenohScoutTransport } from "../../src/transports/zenoh-scout";
import { discoveryTransport } from "../../src/transports";

describe("zenoh-scout plugin (#1455)", () => {
  test("manifest is valid and exposes opt-in cli/api surfaces", () => {
    const loaded = loadManifestFromDir(join(import.meta.dir, "../../src/vendor/mpr-plugins/zenoh-scout"));
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

  test("formats disabled, unavailable, empty, and populated results", () => {
    const base = {
      locator: "ws://router:10000",
      keyPrefix: "maw/test/v1",
      total: 0,
      peers: [],
    };

    expect(formatZenohScoutResult({ ...base, ok: true, enabled: false })).toContain("zenoh-scout disabled");
    expect(formatZenohScoutResult({ ...base, ok: false, enabled: true })).toContain("error: unknown");
    expect(formatZenohScoutResult({ ...base, ok: true, enabled: true })).toContain("no zenoh discoveries");
    expect(formatZenohScoutResult({
      ...base,
      ok: true,
      enabled: true,
      total: 1,
      peers: [{
        zid: "zenoh:1234567890abcdef",
        node: "white",
        oracle: "pulse",
        host: "not-a-url",
        locators: ["not-a-url"],
        capabilities: [],
        oracles: ["pulse"],
        firstSeen: "2026-05-15T00:00:00.000Z",
        lastSeen: "2026-05-15T00:00:00.000Z",
        seenRel: "now",
        paired: false,
        transport: "zenoh",
      }],
    })).toContain("12345678…");
  });

  test("parses string keyexpr replies and raw non-URL discovery hosts", () => {
    const key = [
      "maw/test/v1",
      Buffer.from("node", "utf8").toString("base64url"),
      Buffer.from("oracle", "utf8").toString("base64url"),
      Buffer.from("not-a-url", "utf8").toString("base64url"),
      Buffer.from("", "utf8").toString("base64url"),
      "alive",
    ].join("/");

    expect(keyexprFromReply({ keyexpr: () => key })).toBe(key);
    expect(keyexprFromReply({ keyexpr: () => Object.create(null) })).toBeNull();
    expect(parseDiscoveryKey(key, "maw/test/v1")?.host).toBe("not-a-url");
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

  test("supports open() fallback, disabled advertising, and empty liveliness receivers", async () => {
    const cfg = readZenohScoutConfig({
      node: "m5",
      oracle: "mawjs",
      zenoh: { locator: "ws://router:10000", scout: { enabled: true, timeoutMs: 0, keyPrefix: "maw/test/v1///" } },
    });
    const calls: string[] = [];

    expect(cfg).toMatchObject({
      locator: "ws://router:10000",
      timeoutMs: 1,
      keyPrefix: "maw/test/v1",
      apiUrl: "http://m5:3456",
    });

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
            calls.push("declare");
            return { async undeclare() { calls.push("undeclare"); } };
          },
          async get(key: FakeKeyExpr) {
            calls.push(`get:${key}`);
            return undefined;
          },
        };
      },
      async close() { calls.push("close"); },
    };

    const fakeZenoh: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      open: async () => {
        calls.push("open");
        return fakeSession;
      },
    };

    const result = await runZenohScout({ ...cfg, advertise: false }, { importZenoh: async () => fakeZenoh });

    expect(result).toMatchObject({ ok: true, total: 0, peers: [] });
    expect(calls).toEqual(["open", "get:maw/test/v1/**", "close"]);
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

  test("missing zenoh-ts module failures get install guidance", async () => {
    const cfg = readZenohScoutConfig({ node: "m5", oracle: "mawjs", zenoh: { scout: { enabled: true } } });
    const result = await runZenohScout(cfg, {
      importZenoh: async () => {
        throw new Error("Cannot find module '@eclipse-zenoh/zenoh-ts'");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("zenoh_unavailable");
    expect(result.hint).toContain("install @eclipse-zenoh/zenoh-ts");
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
    let intervalTick: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const presence: string[] = [];
    (globalThis as any).setInterval = (callback: () => void) => {
      intervalTick = callback;
      return 1;
    };
    (globalThis as any).clearInterval = () => {};
    transport.onMessage(() => {});
    transport.onPresence((p) => presence.push(`${p.oracle}@${p.host}:${p.status}`));
    transport.onFeed(() => {});
    await transport.connect();
    try {
      await transport.publishPresence({ oracle: "mawjs", host: "m5", status: "ready", timestamp: 1 });
      const originalRefresh = (transport as any).refresh;
      (transport as any).refresh = () => Promise.reject(new Error("poll failed"));
      intervalTick?.();
      await Promise.resolve();
      await Promise.resolve();
      (transport as any).refresh = originalRefresh;
      await transport.publishFeed({} as any);
      expect(transport.connected).toBe(true);
      expect(transport.canReach({ oracle: "pulse", host: "clinic" })).toBe(false);
      expect(await transport.send({ oracle: "pulse", host: "clinic" }, "hello")).toBe(false);
      expect(presence).toContain("pulse@clinic:4567:ready");
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
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });


  test("ZenohScoutTransport disconnect swallows zenoh cleanup failures", async () => {
    const local = readZenohScoutConfig({ node: "m5", oracle: "mawjs", port: 3456, zenoh: { scout: { enabled: true } } });

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
            return { async undeclare() { throw new Error("token cleanup failed"); } };
          },
          async get() {
            return (async function* () {})();
          },
        };
      },
      async close() { throw new Error("session cleanup failed"); },
    };

    const fakeZenoh: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      Session: { open: async () => fakeSession },
    };

    const transport = new ZenohScoutTransport({
      ...local,
      enabled: true,
      pollMs: 60_000,
      importZenoh: async () => fakeZenoh,
    });

    await transport.connect();
    await expect(transport.disconnect()).resolves.toBeUndefined();
    expect(transport.connected).toBe(false);
    expect(transport.listPeers()).toEqual([]);
  });


  test("ZenohScoutTransport uses the default zenoh-ts importer when no override is injected", async () => {
    const local = readZenohScoutConfig({ node: "m5", oracle: "mawjs", port: 3456, zenoh: { scout: { enabled: true } } });

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
            return (async function* () {})();
          },
        };
      },
      async close() {},
    };

    mock.module("@eclipse-zenoh/zenoh-ts", () => ({
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      Session: { open: async () => fakeSession },
    }));

    const transport = new ZenohScoutTransport({
      ...local,
      enabled: true,
      pollMs: 60_000,
    });

    await transport.publishPresence({ oracle: "mawjs", host: "m5", status: "ready", timestamp: 1 });
    expect(transport.connected).toBe(true);
    expect(transport.listPeers()).toEqual([]);
    await transport.disconnect();
  });
});
