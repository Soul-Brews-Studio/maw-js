/**
 * Tests for generateFederationToken and isValidFederationToken
 * from src/commands/plugins/init/federation.ts.
 * Pure functions — crypto.randomBytes + string validation.
 */
import { describe, it, expect } from "bun:test";
import { generateFederationToken, isValidFederationToken } from "../../src/commands/plugins/init/federation";

describe("generateFederationToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateFederationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns unique tokens", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateFederationToken()));
    expect(tokens.size).toBe(20);
  });

  it("returns a string", () => {
    expect(typeof generateFederationToken()).toBe("string");
  });
});

describe("isValidFederationToken", () => {
  it("validates a proper token", () => {
    expect(isValidFederationToken(generateFederationToken())).toBe(true);
  });

  it("validates a 16-char token (minimum)", () => {
    expect(isValidFederationToken("abcdef0123456789")).toBe(true);
  });

  it("rejects tokens shorter than 16 chars", () => {
    expect(isValidFederationToken("abc")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidFederationToken("")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidFederationToken(42 as any)).toBe(false);
    expect(isValidFederationToken(null as any)).toBe(false);
    expect(isValidFederationToken(undefined as any)).toBe(false);
  });
});
