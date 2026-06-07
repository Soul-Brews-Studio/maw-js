import { beforeEach, describe, expect, test } from "bun:test";
import {
  _inject,
  _resetStore,
  ALPHABET,
  consume,
  generateCode,
  isValidShape,
  lookup,
  normalize,
  pretty,
  redact,
  register,
  type PairEntry,
} from "../src/lib/pair-codes";

describe("pair-codes pure helpers", () => {
  beforeEach(() => {
    _resetStore();
  });

  test("normalizes, formats, and redacts operator-entered codes", () => {
    expect(normalize("abc-def\n")).toBe("ABCDEF");
    expect(pretty("abc def")).toBe("ABC-DEF");
    expect(pretty("ab")).toBe("AB");
    expect(redact("abc-def")).toBe("ABC-***");
    expect(redact("ab")).toBe("***");
  });

  test("validates the reduced six-character alphabet", () => {
    expect(isValidShape("ABC-234")).toBe(true);
    expect(isValidShape("ABC23")).toBe(false);
    expect(isValidShape("ABC2345")).toBe(false);
    expect(isValidShape("ABC10O")).toBe(false);
    for (const ch of ALPHABET) expect(isValidShape(`AAA${ch}22`)).toBe(true);
  });

  test("generates six-character codes from the allowed alphabet", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCode();
      expect(code).toHaveLength(6);
      expect(isValidShape(code)).toBe(true);
    }
  });

  test("registers, looks up, consumes, and rejects reused codes", () => {
    const entry = register("abc-def", 60_000);
    expect(entry.code).toBe("ABCDEF");
    expect(entry.consumed).toBe(false);
    expect(entry.expiresAt).toBeGreaterThanOrEqual(entry.createdAt);

    const found = lookup("ABC DEF");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.entry).toBe(entry);

    const consumed = consume("abcdef");
    expect(consumed.ok).toBe(true);
    expect(entry.consumed).toBe(true);
    expect(lookup("abcdef")).toEqual({ ok: false, reason: "consumed" });
    expect(consume("abcdef")).toEqual({ ok: false, reason: "consumed" });
  });

  test("reports missing and expired pair codes", () => {
    expect(lookup("missing")).toEqual({ ok: false, reason: "not_found" });

    const expired: PairEntry = {
      code: "ABCDEF",
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1,
      consumed: false,
    };
    _inject(expired);
    expect(lookup("abc-def")).toEqual({ ok: false, reason: "expired" });
    expect(consume("abc-def")).toEqual({ ok: false, reason: "expired" });
  });
});
