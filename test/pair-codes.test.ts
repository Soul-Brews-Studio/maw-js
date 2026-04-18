/**
 * maw pair — codes.ts unit tests (#573).
 *
 * Covers: alphabet purity, shape validation, uniqueness (statistical),
 * pretty/normalize round-trip, TTL enforcement, single-use semantics.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  ALPHABET,
  generateCode,
  isValidShape,
  normalize,
  pretty,
  redact,
  register,
  lookup,
  consume,
  _resetStore,
  _inject,
} from "../src/commands/plugins/pair/codes";

describe("pair codes — generation & shape", () => {
  it("ALPHABET excludes confusable characters I O 0 1 l", () => {
    expect(ALPHABET).not.toContain("I");
    expect(ALPHABET).not.toContain("O");
    expect(ALPHABET).not.toContain("0");
    expect(ALPHABET).not.toContain("1");
    expect(ALPHABET).not.toContain("l");
    expect(ALPHABET.length).toBe(32);
  });

  it("generateCode returns a 6-char string from ALPHABET", () => {
    for (let i = 0; i < 100; i++) {
      const c = generateCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ALPHABET).toContain(ch);
    }
  });

  it("generateCode has low collision rate (1000 samples)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateCode());
    // 30 bits of entropy → collision probability at 1000 samples is ~0.05%
    expect(seen.size).toBeGreaterThan(995);
  });

  it("isValidShape accepts both hyphenated and raw forms", () => {
    const c = generateCode();
    expect(isValidShape(c)).toBe(true);
    expect(isValidShape(pretty(c))).toBe(true);
    expect(isValidShape(c.toLowerCase())).toBe(true);
  });

  it("isValidShape rejects bad length / bad chars", () => {
    expect(isValidShape("ABC-DE")).toBe(false);   // 5 chars
    expect(isValidShape("ABCDEFG")).toBe(false);  // 7 chars
    expect(isValidShape("ABCDE0")).toBe(false);   // 0 excluded
    expect(isValidShape("ABCDEI")).toBe(false);   // I excluded
    expect(isValidShape("")).toBe(false);
  });

  it("pretty inserts hyphen, normalize removes it", () => {
    expect(pretty("W4K7F3")).toBe("W4K-7F3");
    expect(normalize("w4k-7f3")).toBe("W4K7F3");
    expect(normalize(" W4K-7F3 ")).toBe("W4K7F3");
  });

  it("redact masks the last 3 chars", () => {
    expect(redact("W4K7F3")).toBe("W4K-***");
    expect(redact("W4K-7F3")).toBe("W4K-***");
  });
});

describe("pair codes — TTL & single-use", () => {
  beforeEach(() => _resetStore());

  it("register then lookup succeeds within TTL", () => {
    const code = generateCode();
    register(code, 5000);
    const r = lookup(code);
    expect(r.ok).toBe(true);
  });

  it("lookup returns not_found for an unregistered code", () => {
    const r = lookup(generateCode());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("expired code is rejected with reason=expired", () => {
    const code = generateCode();
    _inject({ code: normalize(code), expiresAt: Date.now() - 1, consumed: false, createdAt: Date.now() - 1000 });
    const r = lookup(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("consumed code is rejected on subsequent lookup", () => {
    const code = generateCode();
    register(code, 5000);
    const first = consume(code);
    expect(first.ok).toBe(true);
    const second = consume(code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("consumed");
    const third = lookup(code);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe("consumed");
  });

  it("consume is atomic — second call sees consumed (single-use)", () => {
    const code = generateCode();
    register(code, 5000);
    const a = consume(code);
    const b = consume(code);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  it("case-insensitive lookup works after register", () => {
    const code = generateCode();
    register(code, 5000);
    expect(lookup(code.toLowerCase()).ok).toBe(true);
    expect(lookup(pretty(code)).ok).toBe(true);
  });
});
