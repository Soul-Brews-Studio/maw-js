import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const peekCalls: Array<string | undefined> = [];
let shouldThrow: Error | null = null;

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  cmdPeek: async (query?: string) => {
    peekCalls.push(query);
    if (shouldThrow) throw shouldThrow;
    console.log(`peeked:${query ?? "overview"}`);
  },
}));

const { default: peekHandler } = await import("../../src/vendor/mpr-plugins/peek/index.ts?plugin-peek-standalone");

beforeEach(() => {
  peekCalls.length = 0;
  shouldThrow = null;
});

describe("peek plugin standalone boundary (#2113)", () => {
  test("imports runtime behavior from the SDK boundary", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/peek/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("CLI handler routes target to SDK cmdPeek", async () => {
    const result = await peekHandler({ source: "cli", args: ["neo", "ignored"] } as any);

    expect(result.ok).toBe(true);
    expect(peekCalls).toEqual(["neo"]);
    expect(result.output).toContain("peeked:neo");
  });

  test("non-CLI handler uses fleet overview and returns errors from SDK", async () => {
    const overview = await peekHandler({ source: "api", args: { target: "neo" } } as any);
    expect(overview.ok).toBe(true);
    expect(peekCalls).toEqual([undefined]);

    shouldThrow = new Error("no such oracle");
    const failed = await peekHandler({ source: "cli", args: ["ghost"] } as any);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("no such oracle");
    expect(failed.output).toBeUndefined();
  });
});
