import { describe, expect, test } from "bun:test";
import {
  discoveryKey,
  encodeSegment,
  formatZenohScoutResult,
  keyexprFromReply,
  parseDiscoveryKey,
  readZenohScoutConfig,
  runZenohScout,
  type ZenohApi,
} from "../../src/vendor/mpr-plugins/zenoh-scout/impl";

class FakeConfig {
  constructor(public locator: string, public timeoutMs?: number) {}
}

class FakeKeyExpr {
  constructor(public key: string) {}
  toString() {
    return this.key;
  }
}

function replyFor(key: string) {
  return { result: () => ({ keyexpr: () => ({ toString: () => key }) }) };
}

function zenohWithSession(session: unknown, extras: Partial<ZenohApi> = {}): ZenohApi {
  return {
    Config: FakeConfig,
    KeyExpr: FakeKeyExpr,
    Session: { open: async () => session as any },
    ...extras,
  };
}

describe("zenoh-scout impl extra branch coverage", () => {
  test("readZenohScoutConfig applies defaults, locator precedence, timeout floor, and key prefix trimming", () => {
    expect(readZenohScoutConfig({} as any)).toEqual({
      enabled: false,
      locator: "ws://127.0.0.1:10000",
      timeoutMs: 750,
      keyPrefix: "maw/discovery/v1",
      node: "local",
      oracle: "mawjs",
      apiUrl: "http://local:3456",
      capabilities: ["pair", "feed", "send"],
      advertise: true,
    });

    expect(readZenohScoutConfig({
      node: "m5",
      oracle: "codex",
      port: 9999,
      zenoh: {
        locator: "ws://router:10000",
        scout: {
          enabled: true,
          locator: "ws://scout:10000",
          timeoutMs: -10,
          keyPrefix: "maw/custom///",
        },
      },
    } as any)).toMatchObject({
      enabled: true,
      locator: "ws://scout:10000",
      timeoutMs: 1,
      keyPrefix: "maw/custom",
      node: "m5",
      oracle: "codex",
      apiUrl: "http://m5:9999",
    });

    expect(readZenohScoutConfig({
      zenoh: {
        locator: "ws://router:10000",
        scout: { timeoutMs: Number.NaN, keyPrefix: "///" },
      },
    } as any)).toMatchObject({
      locator: "ws://router:10000",
      timeoutMs: 750,
      keyPrefix: "maw/discovery/v1",
    });
  });

  test("parseDiscoveryKey rejects malformed keys and handles opaque hosts plus empty capabilities", () => {
    const now = new Date("2026-05-18T00:00:00.000Z");
    expect(parseDiscoveryKey("other/node/oracle/url/caps/alive", "maw/test", now)).toBeNull();
    expect(parseDiscoveryKey("maw/test/too/few/parts", "maw/test", now)).toBeNull();
    expect(parseDiscoveryKey(`maw/test/${encodeSegment("node")}/${encodeSegment("oracle")}/${encodeSegment("url")}/${encodeSegment("caps")}/dead`, "maw/test", now)).toBeNull();
    expect(parseDiscoveryKey(`maw/test//${encodeSegment("oracle")}/${encodeSegment("url")}/${encodeSegment("caps")}/alive`, "maw/test", now)).toBeNull();

    const opaque = parseDiscoveryKey(
      `maw/test/${encodeSegment("node")}/${encodeSegment("oracle")}/${encodeSegment("not a url")}/${encodeSegment("")}/alive`,
      "maw/test///",
      now,
    );
    expect(opaque).toMatchObject({
      node: "node",
      oracle: "oracle",
      host: "not a url",
      locators: ["not a url"],
      capabilities: [],
      firstSeen: "2026-05-18T00:00:00.000Z",
      seenRel: "now",
      paired: false,
      transport: "zenoh",
    });
  });

  test("keyexprFromReply accepts direct samples and result wrappers without leaking mocks", () => {
    expect(keyexprFromReply({ keyexpr: () => "maw/direct" })).toBe("maw/direct");
    expect(keyexprFromReply({ result: () => ({ keyexpr: () => ({ toString: () => "maw/wrapped" }) }) })).toBe("maw/wrapped");
    expect(keyexprFromReply({ result: "not-a-sample" })).toBeNull();
    expect(keyexprFromReply({ keyexpr: () => null })).toBeNull();
  });

  test("formatZenohScoutResult covers disabled, unavailable, empty, and table output", () => {
    expect(formatZenohScoutResult({
      ok: true,
      enabled: false,
      locator: "ws://router",
      keyPrefix: "maw/test",
      total: 0,
      peers: [],
    })).toBe("zenoh-scout disabled\n  locator: ws://router\n  hint: set zenoh.scout.enabled=true");

    expect(formatZenohScoutResult({
      ok: false,
      enabled: true,
      locator: "ws://router",
      keyPrefix: "maw/test",
      total: 0,
      peers: [],
      error: "zenoh_unavailable",
    })).toBe("zenoh-scout unavailable\n  locator: ws://router\n  error: zenoh_unavailable\n  hint: check zenohd remote-api");

    expect(formatZenohScoutResult({
      ok: true,
      enabled: true,
      locator: "ws://router",
      keyPrefix: "maw/test",
      total: 0,
      peers: [],
    })).toBe("no zenoh discoveries\n  locator: ws://router\n  key: maw/test/**");

    const table = formatZenohScoutResult({
      ok: true,
      enabled: true,
      locator: "ws://router",
      keyPrefix: "maw/test",
      total: 2,
      peers: [
        { zid: "zenoh:abcdef123456", node: "b", oracle: "pulse", host: "b:1", locators: [], capabilities: [], oracles: ["pulse"], firstSeen: "", lastSeen: "", seenRel: "now", paired: false, transport: "zenoh" },
        { zid: "plain-zid", node: "aa", oracle: "mawjs", host: "aa:2", locators: [], capabilities: ["pair", "feed"], oracles: ["mawjs"], firstSeen: "", lastSeen: "", seenRel: "now", paired: false, transport: "zenoh" },
      ],
    });
    expect(table).toContain("zid");
    expect(table).toContain("abcdef12…");
    expect(table).toContain("plain-zi…");
    expect(table).toContain("pair,feed");
    expect(table).toContain("- ");
  });

  test("runZenohScout supports zenoh.open fallback, advertise=false, numeric timeout fallback, and empty receivers", async () => {
    const calls: string[] = [];
    const session = {
      liveliness() {
        return {
          async declareToken() {
            calls.push("declare");
            return { async undeclare() { calls.push("undeclare"); } };
          },
          async get(key: FakeKeyExpr, opts: Record<string, unknown>) {
            calls.push(`get:${key}:${opts.timeout}`);
            return undefined;
          },
        };
      },
      async close() { calls.push("close"); },
    };
    const api: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      open: async (config: unknown) => {
        expect(config).toBeInstanceOf(FakeConfig);
        calls.push("open");
        return session as any;
      },
    };

    const result = await runZenohScout({
      ...readZenohScoutConfig({ node: "m5", oracle: "mawjs", zenoh: { scout: { enabled: true } } } as any),
      advertise: false,
    }, { importZenoh: async () => api });

    expect(result).toMatchObject({ ok: true, enabled: true, total: 0, peers: [] });
    expect(calls).toEqual(["open", "get:maw/discovery/v1/**:750", "close"]);
  });

  test("runZenohScout deduplicates, sorts, ignores bad replies, and swallows success cleanup failures", async () => {
    const local = readZenohScoutConfig({ node: "m5", oracle: "mawjs", port: 3456, zenoh: { scout: { enabled: true } } } as any);
    const zed = readZenohScoutConfig({ node: "zed", oracle: "aaa", port: 4567, zenoh: { scout: { enabled: true } } } as any);
    const alpha = readZenohScoutConfig({ node: "alpha", oracle: "zzz", port: 5678, zenoh: { scout: { enabled: true } } } as any);
    const zedKey = discoveryKey(zed);
    const alphaKey = discoveryKey(alpha);
    const calls: string[] = [];
    const session = {
      liveliness() {
        return {
          async declareToken(key: FakeKeyExpr) {
            calls.push(`declare:${key}`);
            return { async undeclare() { calls.push("undeclare"); throw new Error("ignored undeclare"); } };
          },
          async get() {
            return (async function* () {
              yield { result: () => "not-a-sample" };
              yield replyFor(zedKey);
              yield replyFor(alphaKey);
              yield replyFor(zedKey);
              yield replyFor("maw/discovery/v1/not/enough");
            })();
          },
        };
      },
      async close() { calls.push("close"); throw new Error("ignored close"); },
    };

    const result = await runZenohScout(local, {
      importZenoh: async () => zenohWithSession(session, { Duration: { milliseconds: { of: (ms: number) => `duration:${ms}` } } }),
      now: () => new Date("2026-05-18T01:02:03.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.peers.map((peer) => `${peer.node}:${peer.oracle}`)).toEqual(["alpha:zzz", "zed:aaa"]);
    expect(result.peers[0]?.lastSeen).toBe("2026-05-18T01:02:03.000Z");
    expect(calls).toEqual([`declare:${discoveryKey(local)}`, "undeclare", "close"]);
  });

  test("runZenohScout reports string throws and still cleans up opened sessions", async () => {
    const calls: string[] = [];
    const cfg = readZenohScoutConfig({ node: "m5", oracle: "mawjs", zenoh: { scout: { enabled: true } } } as any);
    const session = {
      liveliness() {
        return {
          async declareToken() {
            return { async undeclare() { calls.push("undeclare"); } };
          },
          async get() {
            throw "Module not found: zenoh bridge";
          },
        };
      },
      async close() { calls.push("close"); },
    };

    const result = await runZenohScout(cfg, { importZenoh: async () => zenohWithSession(session) });

    expect(result).toMatchObject({
      ok: false,
      enabled: true,
      total: 0,
      peers: [],
      error: "zenoh_unavailable",
    });
    expect(result.hint).toContain("install @eclipse-zenoh/zenoh-ts");
    expect(calls).toEqual(["undeclare", "close"]);
  });
});
