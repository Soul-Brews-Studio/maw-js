import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  serve,
  startServePrWatch,
} from "../../src/vendor-plugins/serve-pr-watch/index.ts?plugin-serve-pr-watch-standalone";

const root = join(import.meta.dir, "../..");

describe("serve-pr-watch plugin standalone boundary", () => {
  test("declares fail-fast serve hook for pr-watch polling", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toContain("startServePrWatch");
  });

  test("plugin.ts and plugin.json stay in sync", () => {
    const jsonManifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.json"), "utf8"));
    const tsSource = readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.ts"), "utf8");
    expect(tsSource).toContain('"name": "serve-pr-watch"');
    expect(tsSource).toContain('"serve:pr:watch"');
    expect(jsonManifest.name).toBe("serve-pr-watch");
  });

  test("boundary drift is explicit — pr-watch is the only allowed core reach", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-pr-watch",
      pluginDir: "src/vendor-plugins/serve-pr-watch",
      requireSdk: false,
      allowRelative: [/^\.\.\/\.\.\/core\/worklog\/pr-watch$/],
    });
  });

  test("startServePrWatch schedules pollPrsOnce on the configured interval and returns a stop handle", () => {
    const calls: string[] = [];
    let tick: (() => void) | null = null;
    const fakeTimer = { unref: () => calls.push("unref") };
    const result = startServePrWatch({
      pollPrsOnce: (async () => { calls.push("poll"); return []; }) as any,
      setInterval: ((handler: () => void, ms: number) => { calls.push(`every:${ms}`); tick = handler; return fakeTimer; }) as any,
      clearInterval: ((t: unknown) => { calls.push("clear"); expect(t).toBe(fakeTimer); }) as any,
      intervalMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["every:5000", "unref"]);

    tick!(); // fire one tick → pollPrsOnce runs
    expect(calls).toContain("poll");

    result.stop();
    expect(calls).toContain("clear");
  });

  test("serve hook delegates to startServePrWatch", () => {
    let started = 0;
    const result = serve({}, {
      pollPrsOnce: (async () => []) as any,
      setInterval: (() => { started += 1; return { unref() {} }; }) as any,
      clearInterval: (() => {}) as any,
      intervalMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(started).toBe(1);
  });
});
