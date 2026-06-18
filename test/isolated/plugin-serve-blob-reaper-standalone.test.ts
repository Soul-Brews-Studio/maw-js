import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  resolveBlobTtlDays,
  serve,
  startServeBlobReap,
} from "../../src/vendor-plugins/serve-blob-reaper/index.ts?plugin-serve-blob-reaper-standalone";

const root = join(import.meta.dir, "../..");

function makeTimerHarness() {
  const handlers: Array<() => void> = [];
  const intervals: number[] = [];
  let unrefCount = 0;
  return {
    handlers,
    intervals,
    get unrefCount() { return unrefCount; },
    setInterval(handler: () => void, timeout: number) {
      handlers.push(handler);
      intervals.push(timeout);
      return { unref: () => { unrefCount += 1; } };
    },
  };
}

describe("serve-blob-reaper plugin standalone boundary", () => {
  afterEach(() => { delete process.env.MAW_UPLOAD_TTL_DAYS; });

  test("declares best-effort serve hook for upload-blob reaping", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-blob-reaper/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "best-effort" });
    expect(manifest.tier).toBe("core");
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toContain("startServeBlobReap");
  });

  test("boundary drift is explicit for this core lifecycle plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-blob-reaper",
      pluginDir: "src/vendor-plugins/serve-blob-reaper",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/api\/upload$/,
      ],
    });
  });

  test("TTL resolves from env, falls back to 7d default, rejects junk", () => {
    expect(resolveBlobTtlDays()).toBe(7);
    process.env.MAW_UPLOAD_TTL_DAYS = "3";
    expect(resolveBlobTtlDays()).toBe(3);
    process.env.MAW_UPLOAD_TTL_DAYS = "0";
    expect(resolveBlobTtlDays()).toBe(7);
    process.env.MAW_UPLOAD_TTL_DAYS = "nonsense";
    expect(resolveBlobTtlDays()).toBe(7);
  });

  test("reaps immediately at startup, on interval, logs removals, swallows errors", () => {
    const timer = makeTimerHarness();
    const info: string[] = [];
    const errors: unknown[][] = [];
    let result = { web: 2, inbox: 1 };
    let boom = false;

    startServeBlobReap({
      reapOldUploads: () => { if (boom) throw new Error("reap boom"); return result; },
      setInterval: timer.setInterval,
    }, {
      info: (line) => info.push(String(line)),
      error: (...args) => errors.push(args),
    });

    // immediate sweep at startup logged, 6h interval armed + unref'd
    expect(info).toEqual(["[blob-reap] removed 2 web + 1 inbox blob(s) older than 7d"]);
    expect(timer.intervals).toEqual([6 * 60 * 60 * 1000]);
    expect(timer.unrefCount).toBe(1);

    // nothing removed → no log noise
    result = { web: 0, inbox: 0 };
    timer.handlers[0]();
    expect(info).toHaveLength(1);

    // reaper throwing is swallowed + logged, never crashes serve
    boom = true;
    timer.handlers[0]();
    expect(errors[0][0]).toBe("[blob-reap] failed:");
    expect(errors[0][1]).toBeInstanceOf(Error);
  });

  test("serve hook returns the armed timer", () => {
    const timer = makeTimerHarness();
    const result = serve({}, {
      reapOldUploads: () => ({ web: 0, inbox: 0 }),
      setInterval: timer.setInterval,
    });
    expect(result.ok).toBe(true);
    expect(timer.intervals).toEqual([6 * 60 * 60 * 1000]);
  });
});
