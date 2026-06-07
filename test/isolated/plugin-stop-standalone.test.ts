import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
let sleepCalls = 0;
let fail: Error | null = null;

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  cmdSleep: async () => {
    sleepCalls += 1;
    if (fail) throw fail;
    console.log("fleet slept");
  },
}));

const { default: stopHandler } = await import("../../src/vendor/mpr-plugins/stop/index.ts?plugin-stop-standalone");

beforeEach(() => {
  sleepCalls = 0;
  fail = null;
});

describe("stop plugin standalone boundary (#2113)", () => {
  test("imports runtime behavior from the SDK boundary", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/stop/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|lib|config)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("handler stops the fleet through SDK cmdSleep", async () => {
    const result = await stopHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(sleepCalls).toBe(1);
    expect(result.output).toContain("fleet slept");
  });

  test("handler returns SDK errors and captured output", async () => {
    fail = new Error("tmux unavailable");

    const result = await stopHandler({ source: "api", args: {} } as any);

    expect(result.ok).toBe(false);
    expect(sleepCalls).toBe(1);
    expect(result.error).toBe("tmux unavailable");
  });
});
