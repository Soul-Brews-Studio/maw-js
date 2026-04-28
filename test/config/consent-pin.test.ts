/**
 * Tests for src/core/consent/pin.ts — generatePin, hashPin, verifyPin.
 * Pure crypto functions.
 */
import { describe, it, expect } from "bun:test";
import { generatePin, hashPin, verifyPin, isValidShape, normalize, pretty } from "../../src/core/consent/pin";

describe("generatePin", () => {
  it("returns a 6-char string", () => {
    const pin = generatePin();
    expect(pin).toHaveLength(6);
  });

  it("returns valid shape", () => {
    const pin = generatePin();
    expect(isValidShape(pin)).toBe(true);
  });

  it("generates unique pins", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    // With 30 bits of entropy, 20 should all be unique
    expect(pins.size).toBe(20);
  });

  it("uses only allowed alphabet characters", () => {
    const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const pin = generatePin();
    for (const ch of pin) {
      expect(ALPHABET).toContain(ch);
    }
  });
});

describe("hashPin", () => {
  it("returns hex string", () => {
    const hash = hashPin("ABC123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes input before hashing", () => {
    // With and without hyphen should produce same hash
    expect(hashPin("ABC-123")).toBe(hashPin("ABC123"));
  });

  it("is case-insensitive", () => {
    expect(hashPin("abc123")).toBe(hashPin("ABC123"));
  });

  it("produces deterministic output", () => {
    expect(hashPin("TEST42")).toBe(hashPin("TEST42"));
  });

  it("different pins produce different hashes", () => {
    expect(hashPin("AAAAAA")).not.toBe(hashPin("BBBBBB"));
  });
});

describe("verifyPin", () => {
  it("returns true for matching pin and hash", () => {
    const pin = generatePin();
    const hash = hashPin(pin);
    expect(verifyPin(pin, hash)).toBe(true);
  });

  it("returns false for wrong pin", () => {
    const hash = hashPin("ABC123");
    expect(verifyPin("XYZ789", hash)).toBe(false);
  });

  it("returns false for invalid shape", () => {
    const hash = hashPin("ABC123");
    // "OOOOOO" contains 'O' which is not in the alphabet
    expect(verifyPin("OOOOOO", hash)).toBe(false);
  });

  it("handles hyphenated pin input", () => {
    const pin = generatePin();
    const hash = hashPin(pin);
    const pretty_pin = pretty(pin);
    expect(verifyPin(pretty_pin, hash)).toBe(true);
  });

  it("handles lowercase input", () => {
    const pin = generatePin();
    const hash = hashPin(pin);
    expect(verifyPin(pin.toLowerCase(), hash)).toBe(true);
  });
});
