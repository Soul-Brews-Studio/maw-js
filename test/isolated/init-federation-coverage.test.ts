import { describe, expect, test } from "bun:test";

const {
  generateFederationToken,
  isValidFederationToken,
} = await import("../../src/vendor/mpr-plugins/init/federation.ts?init-federation-coverage");

describe("init federation coverage", () => {
  test("generates a hex token accepted by the validator", () => {
    const token = generateFederationToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidFederationToken(token)).toBe(true);
  });

  test("validates string token length only", () => {
    expect(isValidFederationToken("1234567890abcdef")).toBe(true);
    expect(isValidFederationToken("short")).toBe(false);
    expect(isValidFederationToken(undefined as unknown as string)).toBe(false);
  });
});
