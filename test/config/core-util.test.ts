/**
 * Tests for src/core/util/ — fuzzy, sanitize-log, try-silent, user-error.
 *
 * All pure functions with no side effects.
 */
import { describe, it, expect } from "bun:test";
import { distance, fuzzyMatch } from "../../src/core/util/fuzzy";
import { sanitizeLogField } from "../../src/core/util/sanitize-log";
import { trySilent, trySilentAsync } from "../../src/core/util/try-silent";
import { UserError, isUserError } from "../../src/core/util/user-error";

// ─── fuzzy.ts ──────────────────────────────────────────────────────

describe("distance (Levenshtein)", () => {
  it("returns 0 for identical strings", () => {
    expect(distance("hello", "hello")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(distance("", "abc")).toBe(3);
    expect(distance("abc", "")).toBe(3);
  });

  it("returns 0 for two empty strings", () => {
    expect(distance("", "")).toBe(0);
  });

  it("computes single substitution", () => {
    expect(distance("cat", "car")).toBe(1);
  });

  it("computes single insertion", () => {
    expect(distance("cat", "cats")).toBe(1);
  });

  it("computes single deletion", () => {
    expect(distance("cats", "cat")).toBe(1);
  });

  it("computes multiple edits", () => {
    expect(distance("kitten", "sitting")).toBe(3);
  });

  it("is symmetric", () => {
    expect(distance("abc", "xyz")).toBe(distance("xyz", "abc"));
  });
});

describe("fuzzyMatch", () => {
  const commands = ["wake", "sleep", "hey", "peek", "status", "ls", "send", "view"];

  it("returns exact match first", () => {
    const result = fuzzyMatch("wake", commands);
    expect(result[0]).toBe("wake");
  });

  it("suggests similar commands for typo", () => {
    const result = fuzzyMatch("wak", commands);
    expect(result).toContain("wake");
  });

  it("is case-insensitive", () => {
    const result = fuzzyMatch("WAKE", commands);
    expect(result).toContain("wake");
  });

  it("returns empty for empty input", () => {
    expect(fuzzyMatch("", commands)).toEqual([]);
  });

  it("respects maxResults", () => {
    const result = fuzzyMatch("s", commands, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("respects maxDistance", () => {
    const result = fuzzyMatch("zzzzz", commands, 3, 1);
    expect(result).toEqual([]);
  });

  it("deduplicates candidates", () => {
    const result = fuzzyMatch("wake", ["wake", "wake", "wake"]);
    expect(result).toEqual(["wake"]);
  });

  it("sorts by distance ascending, then alphabetically", () => {
    const result = fuzzyMatch("hep", ["hey", "help", "heap", "hero"]);
    // hey=1, heap=1, help=1, hero=2 — alphabetical within ties
    expect(result[0]).toBe("heap");
    expect(result[1]).toBe("help");
    expect(result[2]).toBe("hey");
  });

  it("skips empty candidates", () => {
    const result = fuzzyMatch("hey", ["", "hey", ""]);
    expect(result).toEqual(["hey"]);
  });
});

// ─── sanitize-log.ts ───────────────────────────────────────────────

describe("sanitizeLogField", () => {
  it("passes through clean strings unchanged", () => {
    expect(sanitizeLogField("hello world")).toBe("hello world");
  });

  it("strips ANSI CSI sequences", () => {
    const colored = "\x1b[31mred\x1b[0m";
    const result = sanitizeLogField(colored);
    expect(result).toBe("red");
    expect(result).not.toContain("\x1b");
  });

  it("strips ANSI OSC sequences", () => {
    const osc = "\x1b]0;title\x07rest";
    const result = sanitizeLogField(osc);
    expect(result).toBe("rest");
  });

  it("replaces newlines with visible markers", () => {
    const result = sanitizeLogField("line1\nline2");
    expect(result).toContain("\\x0a");
    expect(result).not.toContain("\n");
  });

  it("replaces NUL byte", () => {
    const result = sanitizeLogField("before\x00after");
    expect(result).toContain("\\x00");
  });

  it("replaces BEL", () => {
    const result = sanitizeLogField("text\x07more");
    expect(result).toContain("\\x07");
  });

  it("preserves tab characters", () => {
    const result = sanitizeLogField("col1\tcol2");
    expect(result).toBe("col1\tcol2");
  });

  it("truncates at maxLen", () => {
    const long = "a".repeat(300);
    const result = sanitizeLogField(long, 200);
    expect(result.length).toBeLessThan(300);
    expect(result).toContain("…[+");
  });

  it("does not truncate when maxLen is 0", () => {
    const long = "a".repeat(300);
    const result = sanitizeLogField(long, 0);
    expect(result).toBe(long);
  });

  it("handles undefined", () => {
    expect(sanitizeLogField(undefined)).toBe("undefined");
  });

  it("handles null", () => {
    expect(sanitizeLogField(null)).toBe("null");
  });

  it("handles number", () => {
    expect(sanitizeLogField(42)).toBe("42");
  });

  it("handles object with custom toString that throws", () => {
    const evil = { toString() { throw new Error("boom"); } };
    expect(sanitizeLogField(evil)).toBe("[unstringifiable]");
  });
});

// ─── try-silent.ts ─────────────────────────────────────────────────

describe("trySilent", () => {
  it("returns value on success", () => {
    expect(trySilent(() => 42)).toBe(42);
  });

  it("returns undefined on throw", () => {
    expect(trySilent(() => { throw new Error("boom"); })).toBeUndefined();
  });
});

describe("trySilentAsync", () => {
  it("resolves value on success", async () => {
    expect(await trySilentAsync(async () => 42)).toBe(42);
  });

  it("resolves undefined on rejection", async () => {
    expect(await trySilentAsync(async () => { throw new Error("boom"); })).toBeUndefined();
  });
});

// ─── user-error.ts ─────────────────────────────────────────────────

describe("UserError", () => {
  it("is an instance of Error", () => {
    const err = new UserError("bad input");
    expect(err).toBeInstanceOf(Error);
  });

  it("has isUserError brand", () => {
    const err = new UserError("bad");
    expect(err.isUserError).toBe(true);
  });

  it("has name 'UserError'", () => {
    const err = new UserError("bad");
    expect(err.name).toBe("UserError");
  });

  it("preserves message", () => {
    const err = new UserError("missing target");
    expect(err.message).toBe("missing target");
  });
});

describe("isUserError", () => {
  it("returns true for UserError instances", () => {
    expect(isUserError(new UserError("bad"))).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isUserError(new Error("normal"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isUserError("string")).toBe(false);
    expect(isUserError(null)).toBe(false);
    expect(isUserError(undefined)).toBe(false);
    expect(isUserError(42)).toBe(false);
  });

  it("returns true for duck-typed object with isUserError brand", () => {
    const duck = Object.assign(new Error("duck"), { isUserError: true as const });
    expect(isUserError(duck)).toBe(true);
  });
});
