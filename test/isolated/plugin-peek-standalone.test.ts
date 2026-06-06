import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

let peekCalls: Array<string | undefined> = [];
let shouldThrow = false;

mock.module("maw-js/commands/shared/comm", () => ({
  cmdPeek: async (target?: string) => {
    peekCalls.push(target);
    console.log(`peeked:${target ?? "default"}`);
    if (shouldThrow) throw new Error("peek failed");
  },
}));

const { command, default: peekHandler } = await import("../../src/vendor/mpr-plugins/peek/index.ts");

beforeEach(() => {
  peekCalls = [];
  shouldThrow = false;
});

describe("peek plugin standalone coverage (#2185)", () => {
  test("has no direct core imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/peek/index.ts"), "utf8");

    expect(source).not.toMatch(/maw-js\/core(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+core\//);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+src\/core\//);
  });

  test("exports command metadata", () => {
    expect(command).toMatchObject({
      name: "peek",
      description: expect.stringContaining("Peek at the latest output"),
    });
  });

  test("CLI args call cmdPeek and capture console output without writer", async () => {
    const result = await peekHandler({ source: "cli", args: ["mawjs-codex-1"] } as any);

    expect(peekCalls).toEqual(["mawjs-codex-1"]);
    expect(result).toEqual({ ok: true, output: "peeked:mawjs-codex-1" });
  });

  test("writer receives output and API source uses default target", async () => {
    const written: string[] = [];
    const result = await peekHandler({
      source: "api",
      args: { target: "ignored-by-wrapper" },
      writer: (...parts: unknown[]) => written.push(parts.map(String).join(" ")),
    } as any);

    expect(peekCalls).toEqual([undefined]);
    expect(written).toEqual(["peeked:default"]);
    expect(result).toEqual({ ok: true, output: undefined });
  });

  test("returns captured output as error when cmdPeek fails", async () => {
    shouldThrow = true;

    const result = await peekHandler({ source: "cli", args: ["broken"] } as any);

    expect(peekCalls).toEqual(["broken"]);
    expect(result).toEqual({ ok: false, error: "peeked:broken", output: "peeked:broken" });
  });
});
