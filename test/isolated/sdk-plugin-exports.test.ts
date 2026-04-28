/**
 * sdk-plugin-exports.test.ts — #844
 *
 * Verifies @maw-js/sdk/plugin exposes the plugin-author surface:
 *   - InvokeContext, InvokeResult (types — already present pre-#844)
 *   - UserError (class) + isUserError() (type guard) — added in #844
 *   - parseFlags (function)                          — added in #844
 *
 * Strategy:
 *   1. Direct import from packages/sdk/plugin.ts to assert runtime exports
 *      and behavior (the .ts file is what the workspace `@maw-js/sdk`
 *      package resolves to — same path plugin authors hit at install time).
 *   2. .d.ts shape check — no parent-relative imports, declares the new
 *      symbols. Mirrors the existing test/sdk-package.test.ts contract.
 *
 * Why isolated: runs in its own bun process so mock pollution from other
 * test files (which monkey-patch tmux/ssh transports) cannot leak. Same
 * convention as the rest of test/isolated/.
 *
 * shellenv (v0.1.0) inlines UserError + parseFlags as TEMP today; once #844
 * lands those inlines drop in v0.2.0. Same pattern unblocks `maw-bg` and
 * any future plugin needing user-facing exits or permissive flag parsing.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  UserError,
  isUserError,
  parseFlags,
} from "../../packages/sdk/plugin";

const PLUGIN_DTS = resolve(__dirname, "..", "..", "packages", "sdk", "plugin.d.ts");

describe("@maw-js/sdk/plugin runtime exports (#844)", () => {
  test("UserError is a constructable class with the expected name", () => {
    const err = new UserError("missing target");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UserError");
    expect(err.message).toBe("missing target");
  });

  test("UserError carries the ESM-safe `isUserError` brand", () => {
    const err = new UserError("bad input");
    // The brand is what survives across ESM realm boundaries — `instanceof`
    // does not. Plugin authors rely on this contract.
    expect((err as { isUserError?: boolean }).isUserError).toBe(true);
  });

  test("isUserError() narrows for thrown UserError instances", () => {
    const err: unknown = new UserError("nope");
    expect(isUserError(err)).toBe(true);
  });

  test("isUserError() returns false for plain Errors and non-errors", () => {
    expect(isUserError(new Error("regular"))).toBe(false);
    expect(isUserError("string")).toBe(false);
    expect(isUserError(null)).toBe(false);
    expect(isUserError(undefined)).toBe(false);
    expect(isUserError({ isUserError: true })).toBe(false); // not an Error
  });

  test("parseFlags is a function exported from the plugin entry", () => {
    expect(typeof parseFlags).toBe("function");
  });

  test("parseFlags parses known flags and routes positionals to `_`", () => {
    const result = parseFlags(
      ["sub", "--verbose", "pos1", "pos2"],
      { "--verbose": Boolean, "-v": "--verbose" },
      1, // skip leading "sub"
    );
    expect(result["--verbose"]).toBe(true);
    expect(result._).toEqual(["pos1", "pos2"]);
  });

  test("parseFlags is permissive — unknown flags do not throw", () => {
    // Permissive mode: --unknown should fall through to `_`, not error.
    expect(() =>
      parseFlags(["--unknown", "value"], { "--known": String }, 0),
    ).not.toThrow();
  });
});

describe("@maw-js/sdk/plugin .d.ts surface (#844)", () => {
  const dts = readFileSync(PLUGIN_DTS, "utf8");

  test(".d.ts is self-contained — no parent-relative imports", () => {
    // Same contract as test/sdk-package.test.ts: must survive file:/tarball
    // installs from outside the repo.
    expect(dts).not.toMatch(/from ["']\.\.\//);
  });

  test(".d.ts declares the new #844 surface", () => {
    expect(dts).toMatch(/export declare class UserError/);
    expect(dts).toMatch(/export declare function isUserError/);
    expect(dts).toMatch(/export declare function parseFlags/);
  });

  test(".d.ts retains the pre-existing InvokeContext / InvokeResult", () => {
    expect(dts).toMatch(/export interface InvokeContext/);
    expect(dts).toMatch(/export interface InvokeResult/);
  });
});
