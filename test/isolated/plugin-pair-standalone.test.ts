import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  _inject,
  _resetStore,
  _storeSize,
  consume,
  lookup,
  normalize,
  prunePairCodes,
  register,
} from "../../src/vendor/mpr-plugins/pair/codes.ts?plugin-pair-standalone";

const root = join(import.meta.dir, "../..");

describe("pair plugin standalone boundary", () => {
  test("declares the pair CLI surface", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/pair/plugin.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "pair",
      entry: "./index.ts",
      cli: {
        command: "pair",
        aliases: [],
      },
    });
  });

  test("boundary drift is explicit for the vendored pair plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "pair",
      requireSdk: false,
      allowMawJs: ["maw-js/config"],
      allowRelative: [
        /^\.\.\/\.\.\/\.\.\/\.\.\/core\/xdg$/,
      ],
    });
  });

  test("pair code store exposes prune behavior through the plugin boundary", () => {
    _resetStore();
    const now = Date.now();
    _inject({ code: "AAAAAA", createdAt: now - 10_000, expiresAt: now - 1, consumed: false });
    _inject({ code: "BBBBBB", createdAt: now - 10_000, expiresAt: now + 60_000, consumed: true });
    _inject({ code: "CCCCCC", createdAt: now, expiresAt: now + 60_000, consumed: false });

    expect(prunePairCodes(now)).toBe(2);
    expect(_storeSize()).toBe(1);
    expect(lookup("CCC-CCC")).toEqual({
      ok: true,
      entry: { code: "CCCCCC", createdAt: now, expiresAt: now + 60_000, consumed: false },
    });
  });

  test("normal code lifecycle still registers, normalizes, and consumes", () => {
    _resetStore();
    const entry = register("abc-def", 60_000);
    expect(entry.code).toBe("ABCDEF");
    expect(normalize("abc-def")).toBe("ABCDEF");
    expect(consume("ABCDEF")).toMatchObject({ ok: true });
    expect(lookup("ABCDEF")).toEqual({ ok: false, reason: "consumed" });
  });
});
