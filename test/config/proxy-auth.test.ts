/**
 * Tests for src/api/proxy-auth.ts — parseProxySignature.
 * Pure function (no I/O, no cookies).
 */
import { describe, it, expect } from "bun:test";
import { parseProxySignature } from "../../src/api/proxy-auth";

describe("parseProxySignature", () => {
  it("parses valid signature", () => {
    const result = parseProxySignature("[white:neo]");
    expect(result).not.toBeNull();
    expect(result!.originHost).toBe("white");
    expect(result!.originAgent).toBe("neo");
    expect(result!.isAnon).toBe(false);
  });

  it("detects anonymous agents", () => {
    const result = parseProxySignature("[remote:anon-1234]");
    expect(result).not.toBeNull();
    expect(result!.isAnon).toBe(true);
  });

  it("returns null for empty string", () => {
    expect(parseProxySignature("")).toBeNull();
  });

  it("returns null for invalid format", () => {
    expect(parseProxySignature("white:neo")).toBeNull();
    expect(parseProxySignature("[whitened]")).toBeNull();
    expect(parseProxySignature("[]")).toBeNull();
  });

  it("handles host with dots", () => {
    const result = parseProxySignature("[white.local:oracle]");
    expect(result).not.toBeNull();
    expect(result!.originHost).toBe("white.local");
  });

  it("handles agent with hyphens", () => {
    const result = parseProxySignature("[node:my-oracle-agent]");
    expect(result).not.toBeNull();
    expect(result!.originAgent).toBe("my-oracle-agent");
  });
});
