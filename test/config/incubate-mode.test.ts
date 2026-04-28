/**
 * Tests for src/commands/plugins/incubate/impl.ts — resolveMode.
 * Pure mode resolution from flag booleans.
 */
import { describe, it, expect } from "bun:test";
import { resolveMode } from "../../src/commands/plugins/incubate/impl";

describe("resolveMode", () => {
  it("returns 'default' when no flags", () => {
    expect(resolveMode(false, false, false, false)).toBe("default");
  });

  it("returns 'flash' when flash=true", () => {
    expect(resolveMode(true, false, false, false)).toBe("flash");
  });

  it("returns 'contribute' when contribute=true", () => {
    expect(resolveMode(false, true, false, false)).toBe("contribute");
  });

  it("returns 'status' when status=true", () => {
    expect(resolveMode(false, false, true, false)).toBe("status");
  });

  it("returns 'offload' when offload=true", () => {
    expect(resolveMode(false, false, false, true)).toBe("offload");
  });

  it("throws on multiple flags", () => {
    expect(() => resolveMode(true, true, false, false)).toThrow("mutually exclusive");
  });

  it("throws on three flags", () => {
    expect(() => resolveMode(true, true, true, false)).toThrow("mutually exclusive");
  });

  it("throws on all four flags", () => {
    expect(() => resolveMode(true, true, true, true)).toThrow("mutually exclusive");
  });
});
