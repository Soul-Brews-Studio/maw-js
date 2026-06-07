/**
 * Extra isolated coverage for the top-level CLI error handler.
 * @maw-test-isolate
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleTopLevelError } from "../../src/cli/error-handler";
import { AmbiguousMatchError } from "../../src/core/runtime/find-window";
import { UserError } from "../../src/core/util/user-error";

const originalExit = process.exit;
const originalError = console.error;
const stderr: string[] = [];

beforeEach(() => {
  stderr.length = 0;
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.exit = ((code?: string | number | null | undefined) => {
    throw new Error(`__exit__:${code ?? 0}`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalError;
});

describe("handleTopLevelError", () => {
  test("exits silently for user-facing UserError failures", () => {
    expect(() => handleTopLevelError(new UserError("bad input"), ["wake"])).toThrow("__exit__:1");

    expect(stderr).toEqual([]);
  });

  test("renders ambiguous tmux matches with actionable context", () => {
    expect(() =>
      handleTopLevelError(new AmbiguousMatchError("neo", ["1-neo:0", "2-neo:0"]), ["a", "neo"]),
    ).toThrow("__exit__:1");

    expect(stderr.join("\n")).toContain("neo");
    expect(stderr.join("\n")).toContain("1-neo:0");
    expect(stderr.join("\n")).toContain("2-neo:0");
  });

  test("prints unexpected errors before exiting", () => {
    const err = new Error("boom");

    expect(() => handleTopLevelError(err, ["wake"])).toThrow("__exit__:1");

    expect(stderr).toEqual([String(err)]);
  });
});
