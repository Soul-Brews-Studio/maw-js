import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  resetServePeerStartupWarningStateForTests,
  runServePeerStartupWarnings,
  serve,
  warnDuplicatePeerIdentityAtBoot,
  warnMissingFederationTokenIfNeeded,
  warnMissingFederationTokenOnce,
} from "../../src/vendor-plugins/serve-peer-startup-warnings/index.ts?plugin-serve-peer-startup-warnings-standalone";
import type { MawConfig } from "../../src/config/types";

const root = join(import.meta.dir, "../..");

function baseConfig(overrides: Partial<MawConfig> = {}): MawConfig {
  return {
    host: "localhost",
    port: 3456,
    node: "m5",
    oracle: "mawjs",
    commands: {},
    env: {},
    ...overrides,
  } as MawConfig;
}

describe("serve-peer-startup-warnings plugin standalone boundary", () => {
  beforeEach(() => {
    resetServePeerStartupWarningStateForTests();
  });

  test("declares best-effort serve hook for peer startup warnings", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-peer-startup-warnings/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "best-effort" });
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toContain("runServePeerStartupWarnings");
  });

  test("boundary drift is explicit for this core lifecycle plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-peer-startup-warnings",
      pluginDir: "src/vendor-plugins/serve-peer-startup-warnings",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/config$/,
        /^\.\.\/\.\.\/core\/bind-host$/,
        /^\.\.\/\.\.\/lib\/peers\/store$/,
        /^\.\.\/\.\.\/lib\/peers\/duplicate-detect$/,
      ],
    });
  });

  test("missing federation token warning fires once when peers expose serve", () => {
    const warns: string[] = [];
    const log = { warn: (line: unknown) => warns.push(String(line)) };

    expect(warnMissingFederationTokenOnce(3099, log)).toBe(true);
    expect(warnMissingFederationTokenOnce(3099, log)).toBe(false);

    expect(warns).toHaveLength(3);
    expect(warns[0]).toContain("peers configured but no federationToken");
    expect(warns[1]).toContain("Port 3099 is exposed");
  });

  test("missing token decision follows bind heuristic and federation token presence", () => {
    const warns: string[] = [];
    const log = { warn: (line: unknown) => warns.push(String(line)) };
    const exposed = { resolveBindHost: () => ({ hostname: "0.0.0.0", reason: "config.peers" as const }) };
    const local = { resolveBindHost: () => ({ hostname: "127.0.0.1", reason: null }) };

    expect(warnMissingFederationTokenIfNeeded(baseConfig(), 3099, log, local)).toBe(false);
    expect(warnMissingFederationTokenIfNeeded(baseConfig({ federationToken: "1234567890123456" }), 3099, log, exposed)).toBe(false);
    expect(warnMissingFederationTokenIfNeeded(baseConfig(), 3099, log, exposed)).toBe(true);
    expect(warns).toHaveLength(3);
  });

  test("duplicate identity scan preserves local identity and non-fatal failure logging", () => {
    const calls: any[] = [];
    const warns: string[] = [];
    const log = { warn: (line: unknown) => warns.push(String(line)) };

    expect(warnDuplicatePeerIdentityAtBoot(baseConfig({ oracle: "sender", node: "m5" }), log, {
      loadPeers: () => ({ peers: { one: { oracle: "sender", node: "m5" } } }),
      warnDuplicatesAtBoot: (input: any) => { calls.push(input); input.log("duplicate warning"); },
    })).toBe(true);

    expect(calls[0]).toMatchObject({
      peers: { one: { oracle: "sender", node: "m5" } },
      local: { oracle: "sender", node: "m5" },
    });
    expect(warns).toEqual(["duplicate warning"]);

    expect(warnDuplicatePeerIdentityAtBoot(baseConfig(), log, {
      loadPeers: () => { throw new Error("peer store boom"); },
      warnDuplicatesAtBoot: () => {},
    })).toBe(false);
    expect(warns[1]).toBe("[startup] peer dedup scan skipped: peer store boom");
  });

  test("serve hook runs both startup warning checks", () => {
    const warns: string[] = [];
    const duplicateCalls: any[] = [];
    const result = serve({ port: 3099, log: { warn: (line) => warns.push(String(line)) } }, {
      loadConfig: () => baseConfig(),
      resolveBindHost: () => ({ hostname: "0.0.0.0", reason: "peers.json" }),
      loadPeers: () => ({ peers: { one: { oracle: "mawjs", node: "m5" } } }),
      warnDuplicatesAtBoot: (input: any) => { duplicateCalls.push(input); },
    });

    expect(result).toEqual({ ok: true, missingTokenWarned: true, duplicateScanRan: true });
    expect(warns[1]).toContain("Port 3099");
    expect(duplicateCalls).toHaveLength(1);
  });

  test("runServePeerStartupWarnings uses config port when context omits one", () => {
    const warns: string[] = [];
    const result = runServePeerStartupWarnings({ log: { warn: (line) => warns.push(String(line)) } }, {
      loadConfig: () => baseConfig({ port: 4123 }),
      resolveBindHost: () => ({ hostname: "0.0.0.0", reason: "MAW_HOST" }),
      loadPeers: () => ({ peers: {} }),
      warnDuplicatesAtBoot: () => {},
    });

    expect(result.missingTokenWarned).toBe(true);
    expect(warns[1]).toContain("Port 4123");
  });
});
