/**
 * Tests for src/api/peer-exec-auth.ts — parseSignature, isReadOnlyCmd.
 * Pure string parsing functions.
 */
import { describe, it, expect } from "bun:test";
import { parseSignature, isReadOnlyCmd } from "../../src/api/peer-exec-auth";

describe("parseSignature", () => {
  it("parses valid signature", () => {
    const result = parseSignature("[white:neo-oracle]");
    expect(result).not.toBeNull();
    expect(result!.originHost).toBe("white");
    expect(result!.originAgent).toBe("neo-oracle");
    expect(result!.isAnon).toBe(false);
  });

  it("detects anonymous agent", () => {
    const result = parseSignature("[white:anon-abc123]");
    expect(result).not.toBeNull();
    expect(result!.isAnon).toBe(true);
  });

  it("returns null for empty string", () => {
    expect(parseSignature("")).toBeNull();
  });

  it("returns null for malformed signature (no brackets)", () => {
    expect(parseSignature("white:neo")).toBeNull();
  });

  it("returns null for malformed signature (no colon)", () => {
    expect(parseSignature("[whiteno]")).toBeNull();
  });

  it("returns null for empty host or agent", () => {
    expect(parseSignature("[:neo]")).toBeNull();
  });
});

describe("isReadOnlyCmd", () => {
  it("recognizes /dig", () => {
    expect(isReadOnlyCmd("/dig")).toBe(true);
  });

  it("recognizes /trace", () => {
    expect(isReadOnlyCmd("/trace")).toBe(true);
  });

  it("recognizes /recap", () => {
    expect(isReadOnlyCmd("/recap")).toBe(true);
  });

  it("recognizes /standup", () => {
    expect(isReadOnlyCmd("/standup")).toBe(true);
  });

  it("recognizes /who-are-you", () => {
    expect(isReadOnlyCmd("/who-are-you")).toBe(true);
  });

  it("recognizes command with args", () => {
    expect(isReadOnlyCmd("/dig maw-js")).toBe(true);
    expect(isReadOnlyCmd("/trace config")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isReadOnlyCmd("  /dig  ")).toBe(true);
  });

  it("rejects unknown commands", () => {
    expect(isReadOnlyCmd("/wake")).toBe(false);
    expect(isReadOnlyCmd("/send")).toBe(false);
  });

  it("rejects partial matches (not prefix)", () => {
    expect(isReadOnlyCmd("/digger")).toBe(false);
  });
});
