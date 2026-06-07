import { describe, expect, test } from "bun:test";
import {
  encodeSegment,
  formatZenohScoutResult,
  keyexprFromReply,
  parseDiscoveryKey,
  discoveryKey,
  readZenohScoutConfig,
  runZenohScout,
  type ZenohApi,
} from "../../src/vendor/mpr-plugins/zenoh-scout/impl";

class FakeConfig {
  constructor(public locator: string, public timeoutMs?: number) {}
}

class FakeKeyExpr {
  constructor(public key: string) {}
  toString() { return this.key; }
}

function replyFor(key: string) {
  return { result: () => ({ keyexpr: () => ({ toString: () => key }) }) };
}

describe("coverage-100 vendor-a zenoh scout gaps", () => {
  test("Session.open path advertises, filters local peers, sorts remotes, and always cleans up", async () => {
    const local = readZenohScoutConfig({ node: "m5", oracle: "codex", port: 3456, zenoh: { scout: { enabled: true, timeoutMs: 25 } } } as any);
    const beta = readZenohScoutConfig({ node: "beta", oracle: "zed", port: 4444, zenoh: { scout: { enabled: true } } } as any);
    const alpha = readZenohScoutConfig({ node: "alpha", oracle: "aaa", port: 5555, zenoh: { scout: { enabled: true } } } as any);
    const calls: string[] = [];
    const session = {
      liveliness() {
        return {
          async declareToken(key: FakeKeyExpr) {
            calls.push(`declare:${key}`);
            return { async undeclare() { calls.push("undeclare"); } };
          },
          async get(key: FakeKeyExpr, opts: Record<string, unknown>) {
            calls.push(`get:${key}:${opts.timeout}`);
            return (async function* () {
              yield replyFor(discoveryKey(local));
              yield replyFor(discoveryKey(beta));
              yield { result: () => "not-a-sample" };
              yield replyFor(discoveryKey(alpha));
            })();
          },
        };
      },
      async close() { calls.push("close"); },
    };
    const api: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      Duration: { milliseconds: { of: (ms: number) => `duration:${ms}` } },
      Session: { open: async () => { calls.push("session-open"); return session as any; } },
    };

    const result = await runZenohScout(local, {
      importZenoh: async () => api,
      now: () => new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.peers.map((p) => `${p.node}/${p.oracle}`)).toEqual(["alpha/aaa", "beta/zed"]);
    expect(calls).toEqual([
      "session-open",
      `declare:${discoveryKey(local)}`,
      "get:maw/discovery/v1/**:duration:25",
      "undeclare",
      "close",
    ]);
  });

  test("failed imports classify module and wasm failures while swallowing cleanup absence", async () => {
    const config = readZenohScoutConfig({ node: "m5", oracle: "codex", zenoh: { scout: { enabled: true } } } as any);

    const missing = await runZenohScout(config, { importZenoh: async () => { throw new Error("Cannot find module '@eclipse-zenoh/zenoh-ts'"); } });
    expect(missing).toMatchObject({ ok: false, error: "zenoh_unavailable", total: 0, peers: [] });
    expect(missing.hint).toContain("install @eclipse-zenoh/zenoh-ts");

    const wasm = await runZenohScout(config, { importZenoh: async () => { throw new Error("WebAssembly __wbindgen failed"); } });
    expect(wasm.error).toBe("zenoh_runtime_unsupported");
    expect(wasm.hint).toContain("failed to initialize");
  });

  test("open fallback, disabled formatting, invalid replies, and non-URL hosts are covered", async () => {
    const config = readZenohScoutConfig({
      node: "m5",
      oracle: "codex",
      port: 3456,
      zenoh: { locator: "ws://root.example", scout: { enabled: false, timeoutMs: 0, keyPrefix: "custom/prefix///" } },
    } as any);
    expect(config).toMatchObject({
      enabled: false,
      locator: "ws://root.example",
      timeoutMs: 1,
      keyPrefix: "custom/prefix",
    });

    const calls: string[] = [];
    const api: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      open: async () => ({
        liveliness: () => ({
          async declareToken() {
            throw new Error("advertise should be disabled");
          },
          async get() {
            calls.push("get");
            return undefined;
          },
        }),
        async close() {
          calls.push("close");
          throw new Error("close ignored");
        },
      }),
    };

    const result = await runZenohScout({ ...config, enabled: true, advertise: false }, { importZenoh: async () => api });
    expect(result).toMatchObject({ ok: true, total: 0, peers: [] });
    expect(calls).toEqual(["get", "close"]);

    expect(formatZenohScoutResult({ ...result, enabled: false, hint: undefined })).toContain("zenoh-scout disabled");
    expect(formatZenohScoutResult({ ...result, ok: false, error: "boom", hint: "fix it" })).toContain("zenoh-scout unavailable");
    expect(formatZenohScoutResult(result)).toContain("no zenoh discoveries");

    const key = [
      "custom/prefix",
      encodeSegment("remote"),
      encodeSegment("oracle"),
      encodeSegment("not a url"),
      encodeSegment("pair,send"),
      "alive",
    ].join("/");
    const parsed = parseDiscoveryKey(key, "custom/prefix", new Date("2026-05-19T00:00:00.000Z"));
    expect(parsed).toMatchObject({ node: "remote", oracle: "oracle", host: "not a url", capabilities: ["pair", "send"] });
    expect(formatZenohScoutResult({ ...result, peers: [parsed!], total: 1 })).toContain("remote");

    expect(parseDiscoveryKey("other/prefix", "custom/prefix")).toBeNull();
    expect(parseDiscoveryKey("custom/prefix/too/few", "custom/prefix")).toBeNull();
    expect(keyexprFromReply({ result: () => ({ keyexpr: () => "literal-key" }) })).toBe("literal-key");
    expect(keyexprFromReply({ result: () => ({}) })).toBeNull();
  });
});
