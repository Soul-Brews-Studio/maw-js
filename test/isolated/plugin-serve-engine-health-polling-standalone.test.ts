import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  serve,
  startServeEngineHealthPolling,
} from "../../src/vendor-plugins/serve-engine-health-polling/index.ts?plugin-serve-engine-health-polling-standalone";

const root = join(import.meta.dir, "../..");

describe("serve-engine-health-polling plugin standalone boundary", () => {
  test("declares fail-fast serve hook for engine health polling", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-engine-health-polling/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toContain("startServeEngineHealthPolling");
  });

  test("boundary drift is explicit for this core lifecycle plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-engine-health-polling",
      pluginDir: "src/vendor-plugins/serve-engine-health-polling",
      requireSdk: false,
      allowRelative: [/^\.\.\/\.\.\/core\/engine-plugin-registry$/],
    });
  });

  test("startServeEngineHealthPolling delegates to engine registry and returns stop handle", () => {
    const calls: string[] = [];
    const stop = () => { calls.push("stop"); };
    const result = startServeEngineHealthPolling({
      startEnginePluginHealthPolling: (() => { calls.push("start"); return stop; }) as any,
    });

    expect(result).toEqual({ ok: true, stopPolling: stop });
    expect(calls).toEqual(["start"]);
    result.stopPolling?.();
    expect(calls).toEqual(["start", "stop"]);
  });

  test("serve hook starts polling", () => {
    let count = 0;
    const result = serve({}, {
      startEnginePluginHealthPolling: (() => { count += 1; return undefined; }) as any,
    });
    expect(result).toEqual({ ok: true, stopPolling: undefined });
    expect(count).toBe(1);
  });
});
