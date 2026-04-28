/**
 * Tests for validateNickname, NICKNAME_MAX_LEN, psiNicknameFile from
 * src/core/fleet/nicknames.ts.
 * Pure validation + path builders — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { validateNickname, NICKNAME_MAX_LEN, psiNicknameFile } from "../../src/core/fleet/nicknames";

// ─── validateNickname ───────────────────────────────────────────────────────

describe("validateNickname", () => {
  it("accepts normal nickname", () => {
    const result = validateNickname("Neo the One");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Neo the One");
  });

  it("trims whitespace", () => {
    const result = validateNickname("  Neo  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Neo");
  });

  it("accepts empty to clear nickname", () => {
    const result = validateNickname("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("");
  });

  it("accepts whitespace-only to clear", () => {
    const result = validateNickname("   ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("");
  });

  it("rejects newlines", () => {
    const result = validateNickname("line1\nline2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("newline");
  });

  it("rejects carriage returns", () => {
    const result = validateNickname("line1\rline2");
    expect(result.ok).toBe(false);
  });

  it("rejects too-long nickname", () => {
    const result = validateNickname("x".repeat(NICKNAME_MAX_LEN + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too long");
  });

  it("accepts exactly max-length nickname", () => {
    const result = validateNickname("x".repeat(NICKNAME_MAX_LEN));
    expect(result.ok).toBe(true);
  });

  it("accepts unicode", () => {
    const result = validateNickname("สิงโต 🦁");
    expect(result.ok).toBe(true);
  });
});

// ─── constants / helpers ────────────────────────────────────────────────────

describe("NICKNAME_MAX_LEN", () => {
  it("is 64", () => {
    expect(NICKNAME_MAX_LEN).toBe(64);
  });
});

describe("psiNicknameFile", () => {
  it("returns ψ/nickname path", () => {
    expect(psiNicknameFile("/repo/neo-oracle")).toBe("/repo/neo-oracle/ψ/nickname");
  });
});
