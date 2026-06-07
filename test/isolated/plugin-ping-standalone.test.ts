import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type PeerConfig = {
  namedPeers?: Array<{ name: string; url: string }>;
  peers?: string[];
};

let config: PeerConfig;
let fetchCalls: Array<{ url: string; options: unknown }>;
let responses: Record<string, { ok: boolean; status?: number; data?: any } | Error>;
let timeouts: string[];

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  loadConfig: () => config,
  cfgTimeout: (key: string) => {
    timeouts.push(key);
    return 1234;
  },
  curlFetch: async (url: string, options: unknown) => {
    fetchCalls.push({ url, options });
    const response = responses[url];
    if (response instanceof Error) throw response;
    return response ?? { ok: true, data: { enabled: false } };
  },
}));

const { default: pingHandler } = await import("../../src/vendor/mpr-plugins/ping/index.ts?plugin-ping-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  config = { namedPeers: [], peers: [] };
  fetchCalls = [];
  responses = {};
  timeouts = [];
});

describe("ping plugin standalone boundary (#2113/#2184)", () => {
  test("has no direct core/shared/lib/config imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/ping", file), "utf8"),
    );
    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config)(?:\/|\")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    const combined = files.join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain("loadConfig");
    expect(combined).toContain("cfgTimeout");
    expect(combined).toContain("curlFetch");
  });

  test("pings named and legacy peers through SDK helpers", async () => {
    config = {
      namedPeers: [{ name: "alpha", url: "http://alpha.local" }],
      peers: ["http://alpha.local", "http://legacy.local"],
    };
    responses["http://alpha.local/api/auth/status"] = {
      ok: true,
      data: { enabled: true, tokenPreview: "tok…" },
    };
    responses["http://legacy.local/api/auth/status"] = { ok: false, status: 503 };

    const result = await pingHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "http://alpha.local/api/auth/status",
      "http://legacy.local/api/auth/status",
    ]);
    expect(fetchCalls.map((call) => call.options)).toEqual([{ timeout: 1234 }, { timeout: 1234 }]);
    expect(timeouts).toEqual(["ping", "ping"]);
    const output = stripAnsi(result.output);
    expect(output).toContain("alpha (http://alpha.local)");
    expect(output).toContain("auth: ok (tok…)");
    expect(output).toContain("http://legacy.local (http://legacy.local)");
    expect(output).toContain("503");
  });

  test("supports API positional node lookup and reports unknown nodes without fetching", async () => {
    config = { namedPeers: [{ name: "alpha", url: "http://alpha.local" }] };

    const ok = await pingHandler({ source: "api", args: { node: "alpha" } } as any);
    expect(ok.ok).toBe(true);
    expect(fetchCalls.map((call) => call.url)).toEqual(["http://alpha.local/api/auth/status"]);

    fetchCalls = [];
    const missing = await pingHandler({ source: "api", args: { node: "ghost" } } as any);
    expect(missing.ok).toBe(false);
    expect(stripAnsi(missing.error)).toContain("known: alpha");
    expect(fetchCalls).toEqual([]);
  });

  test("no configured peers is a successful no-op", async () => {
    const result = await pingHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("no peers configured");
    expect(fetchCalls).toEqual([]);
  });
});
