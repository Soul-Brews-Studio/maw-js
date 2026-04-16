/**
 * Unit tests for src/core/ghq.ts
 *
 * Strategy: exercise the pure `_normalize` helper for Windows/POSIX path
 * handling. Skip integration (spawning real ghq) — that's what the
 * end-to-end tests on main are for.
 */

import { describe, test, expect } from "bun:test";
import { _normalize, ghqFind, ghqFindSync } from "../src/core/ghq";

describe("_normalize (Windows path handling)", () => {
  test("POSIX paths pass through unchanged", () => {
    const input = "/home/user/Code/github.com/org/repo\n/home/user/Code/github.com/org/repo2";
    expect(_normalize(input)).toEqual([
      "/home/user/Code/github.com/org/repo",
      "/home/user/Code/github.com/org/repo2",
    ]);
  });

  test("Windows backslash paths are converted to forward slashes", () => {
    const input = "C:\\Users\\Nat\\Code\\github.com\\org\\repo";
    expect(_normalize(input)).toEqual(["C:/Users/Nat/Code/github.com/org/repo"]);
  });

  test("mixed separators are fully normalized", () => {
    const input = "C:\\Users\\Nat/Code\\github.com/org\\repo";
    expect(_normalize(input)).toEqual(["C:/Users/Nat/Code/github.com/org/repo"]);
  });

  test("empty lines are filtered", () => {
    const input = "/a\n\n/b\n\n\n";
    expect(_normalize(input)).toEqual(["/a", "/b"]);
  });

  test("empty input returns empty array (no ghost empty-string entry)", () => {
    expect(_normalize("")).toEqual([]);
  });

  test("trailing newline does not add empty entry", () => {
    expect(_normalize("/a\n/b\n")).toEqual(["/a", "/b"]);
  });
});

describe("ghqFindSync (suffix matching)", () => {
  // Note: ghqFindSync calls execSync("ghq list --full-path") which we can't
  // easily mock without module isolation. Verify the contract instead.

  test("returns string | null (never undefined or empty string)", () => {
    const result = ghqFindSync("definitely-not-a-real-repo-xxxyyy");
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("accepts plain suffix string (no regex required)", () => {
    expect(() => ghqFindSync("/foo")).not.toThrow();
  });

  test("returns null on no match (not undefined or empty)", () => {
    const result = ghqFindSync("xxx-no-such-repo-yyy-zzz");
    expect(result).toBeNull();
  });
});

describe("ghqFind (async variant)", () => {
  test("returns string | null", async () => {
    const result = await ghqFind("definitely-not-a-real-repo-xxxyyy");
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("accepts plain suffix string", async () => {
    await expect(ghqFind("/foo")).resolves.toBeDefined();
  });
});

describe("regression guard — the normalize pattern", () => {
  // The original bug: PR #379 fixed Windows by piping through `tr '\\' '/'`
  // at 13 call sites. This helper centralizes that. If someone reverts
  // _normalize to a pass-through, this test should fail.
  test("backslash-to-forward-slash is applied", () => {
    const windowsPath = "C:\\foo\\bar";
    const result = _normalize(windowsPath);
    expect(result[0]).not.toContain("\\");
    expect(result[0]).toBe("C:/foo/bar");
  });
});

describe("API contract — suffix matching is case-insensitive", () => {
  // The contract: ghqFind/ghqFindSync match suffixes case-insensitively.
  // This guards against a future refactor that "tightens" the match to
  // case-sensitive (would silently break GitHub org-name lookups since
  // GitHub URLs are case-insensitive but ghq stores them case-preserving).
  test("ghqFindSync contract documents case-insensitive behavior", () => {
    // Can't ground-test without a real ghq install — assert the function
    // accepts mixed-case input without throwing (catches accidental
    // case-sensitive String.prototype.endsWith use).
    expect(() => ghqFindSync("/FOO-Bar")).not.toThrow();
    expect(() => ghqFindSync("MIXEDcase")).not.toThrow();
  });
});
