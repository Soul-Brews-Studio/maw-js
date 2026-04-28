/**
 * Tests for src/commands/plugins/pair/codes.ts — pair code generation, validation, lifecycle.
 * Pure functions + in-memory store with test helpers.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  ALPHABET, normalize, isValidShape, pretty, redact, generateCode,
  register, lookup, consume, _resetStore, _inject,
} from "../../src/commands/plugins/pair/codes";

beforeEach(() => _resetStore());

// ─── normalize ────────────────────────────────────────────────────

describe("normalize", () => {
  it("uppercases", () => expect(normalize("abc")).toBe("ABC"));
  it("strips hyphens", () => expect(normalize("ABC-DEF")).toBe("ABCDEF"));
  it("strips spaces", () => expect(normalize("AB CD EF")).toBe("ABCDEF"));
  it("handles mixed", () => expect(normalize("ab-cd ef")).toBe("ABCDEF"));
});

// ─── isValidShape ─────────────────────────────────────────────────

describe("isValidShape", () => {
  it("accepts 6-char from ALPHABET", () => {
    expect(isValidShape("ABCDEF")).toBe(true);
  });

  it("accepts with hyphen (normalized)", () => {
    expect(isValidShape("ABC-DEF")).toBe(true);
  });

  it("accepts lowercase (normalized)", () => {
    expect(isValidShape("abcdef")).toBe(true);
  });

  it("rejects too short", () => expect(isValidShape("ABC")).toBe(false));
  it("rejects too long", () => expect(isValidShape("ABCDEFGH")).toBe(false));
  it("rejects empty", () => expect(isValidShape("")).toBe(false));

  it("rejects excluded chars (I, O, 0, 1, l)", () => {
    expect(isValidShape("ABCDI0")).toBe(false); // I not in alphabet
    expect(isValidShape("ABCDO0")).toBe(false); // O not in alphabet
  });
});

// ─── pretty ───────────────────────────────────────────────────────

describe("pretty", () => {
  it("formats 6-char as XXX-XXX", () => {
    expect(pretty("ABCDEF")).toBe("ABC-DEF");
  });

  it("normalizes before formatting", () => {
    expect(pretty("abc-def")).toBe("ABC-DEF");
  });

  it("returns as-is for non-6-char", () => {
    expect(pretty("ABC")).toBe("ABC");
  });
});

// ─── redact ───────────────────────────────────────────────────────

describe("redact", () => {
  it("shows first 3 chars + ***", () => {
    expect(redact("ABCDEF")).toBe("ABC-***");
  });

  it("returns *** for short codes", () => {
    expect(redact("AB")).toBe("***");
  });
});

// ─── generateCode ─────────────────────────────────────────────────

describe("generateCode", () => {
  it("returns 6-char string", () => {
    expect(generateCode()).toHaveLength(6);
  });

  it("uses only ALPHABET chars", () => {
    const code = generateCode();
    for (const ch of code) expect(ALPHABET).toContain(ch);
  });

  it("generates unique codes", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ─── register / lookup / consume lifecycle ────────────────────────

describe("register + lookup + consume", () => {
  it("register creates a valid entry", () => {
    const entry = register("ABCDEF", 60000);
    expect(entry.code).toBe("ABCDEF");
    expect(entry.consumed).toBe(false);
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it("lookup finds registered code", () => {
    register("ABCDEF", 60000);
    const r = lookup("ABCDEF");
    expect(r.ok).toBe(true);
  });

  it("lookup normalizes input", () => {
    register("ABCDEF", 60000);
    const r = lookup("abc-def");
    expect(r.ok).toBe(true);
  });

  it("lookup returns not_found for unknown", () => {
    const r = lookup("XXXXXX");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("lookup returns expired for old code", () => {
    _inject({ code: "ABCDEF", expiresAt: Date.now() - 1000, consumed: false, createdAt: Date.now() - 60000 });
    const r = lookup("ABCDEF");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("consume marks entry as consumed", () => {
    register("ABCDEF", 60000);
    const r = consume("ABCDEF");
    expect(r.ok).toBe(true);
    // Second consume fails
    const r2 = consume("ABCDEF");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("consumed");
  });
});
