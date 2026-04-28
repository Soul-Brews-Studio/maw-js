/**
 * Tests for src/commands/plugins/plugin/install-manifest-helpers.ts — shortHash.
 * Pure string function.
 */
import { describe, it, expect } from "bun:test";
import { shortHash } from "../../src/commands/plugins/plugin/install-manifest-helpers";

describe("shortHash", () => {
  it("extracts first 7 chars from sha256:hex", () => {
    expect(shortHash("sha256:abc1234def5678")).toBe("abc1234");
  });

  it("extracts first 7 chars from plain hex", () => {
    expect(shortHash("abc1234def5678")).toBe("abc1234");
  });

  it("handles short input (< 7 chars)", () => {
    expect(shortHash("abc")).toBe("abc");
  });

  it("handles sha256: prefix with short hex", () => {
    expect(shortHash("sha256:ab")).toBe("ab");
  });

  it("handles exact 7 chars", () => {
    expect(shortHash("1234567")).toBe("1234567");
  });

  it("handles empty string", () => {
    expect(shortHash("")).toBe("");
  });

  it("handles sha256: only (no hex)", () => {
    expect(shortHash("sha256:")).toBe("");
  });

  it("handles full 64-char hex", () => {
    const full = "a".repeat(64);
    expect(shortHash(full)).toBe("aaaaaaa");
  });
});
