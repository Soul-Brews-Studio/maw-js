/**
 * Tests for src/core/fleet/registry-oracle-scan-local.ts — deriveName.
 * Pure string transform: strips -oracle suffix from repo name.
 */
import { describe, it, expect } from "bun:test";
import { deriveName } from "../../src/core/fleet/registry-oracle-scan-local";

describe("deriveName", () => {
  it("strips -oracle suffix", () => {
    expect(deriveName("boom-oracle")).toBe("boom");
  });

  it("returns unchanged if no -oracle suffix", () => {
    expect(deriveName("boom")).toBe("boom");
  });

  it("handles org/repo format", () => {
    expect(deriveName("kanawutc/boom-oracle")).toBe("kanawutc/boom");
  });

  it("only strips trailing -oracle", () => {
    expect(deriveName("oracle-keeper")).toBe("oracle-keeper");
  });

  it("handles just 'oracle'", () => {
    // -oracle suffix only — this doesn't match because there's no prefix before -oracle
    expect(deriveName("oracle")).toBe("oracle");
  });

  it("handles hyphenated name with -oracle", () => {
    expect(deriveName("my-cool-oracle")).toBe("my-cool");
  });

  it("does not strip -oracles (plural)", () => {
    expect(deriveName("multi-oracles")).toBe("multi-oracles");
  });

  it("handles empty string", () => {
    expect(deriveName("")).toBe("");
  });
});
