/**
 * Tests for src/core/consent/pin.ts — generatePin, hashPin, verifyPin,
 * isValidShape, normalize, pretty.
 *
 * Pure crypto functions, no side effects.
 */
import { describe, it, expect } from "bun:test";
import { generatePin, hashPin, verifyPin, isValidShape, normalize, pretty } from "../../src/core/consent/pin";

describe("generatePin", () => {
  it("generates a string", () => {
    expect(typeof generatePin()).toBe("string");
  });

  it("generates 6-character pin", () => {
    expect(generatePin()).toHaveLength(6);
  });

  it("generates different pins", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    expect(pins.size).toBeGreaterThan(1);
  });

  it("uses valid alphabet (no I/O/0/1/l)", () => {
    const pin = generatePin();
    expect(/[IO01l]/.test(pin)).toBe(false);
  });
});

describe("hashPin", () => {
  it("returns SHA-256 hex (64 chars)", () => {
    const hash = hashPin("ABCDEF");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it("is deterministic", () => {
    expect(hashPin("TEST22")).toBe(hashPin("TEST22"));
  });

  it("different pins produce different hashes", () => {
    expect(hashPin("ABCDEF")).not.toBe(hashPin("GHIJKL"));
  });
});

describe("verifyPin", () => {
  it("verifies correct pin", () => {
    const pin = generatePin();
    const hash = hashPin(pin);
    expect(verifyPin(pin, hash)).toBe(true);
  });

  it("rejects wrong pin", () => {
    const hash = hashPin("ABCDEF");
    expect(verifyPin("XXXXXX", hash)).toBe(false);
  });

  it("rejects invalid shape", () => {
    expect(verifyPin("", hashPin("ABCDEF"))).toBe(false);
  });
});

describe("isValidShape", () => {
  it("accepts 6-char valid pin", () => {
    const pin = generatePin();
    expect(isValidShape(pin)).toBe(true);
  });

  it("rejects too short", () => {
    expect(isValidShape("ABC")).toBe(false);
  });

  it("rejects too long", () => {
    expect(isValidShape("ABCDEFGH")).toBe(false);
  });

  it("rejects empty", () => {
    expect(isValidShape("")).toBe(false);
  });
});

describe("normalize", () => {
  it("normalizes a pin string", () => {
    const result = normalize("abc def");
    expect(typeof result).toBe("string");
  });
});

describe("pretty", () => {
  it("formats a pin for display", () => {
    const result = pretty("ABCDEF");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
