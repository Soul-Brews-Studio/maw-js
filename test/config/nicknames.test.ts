/**
 * Tests for src/core/fleet/nicknames.ts — validateNickname (pure),
 * psiNicknameFile (pure path builder).
 */
import { describe, it, expect } from "bun:test";
import { validateNickname, psiNicknameFile, NICKNAME_MAX_LEN } from "../../src/core/fleet/nicknames";

// ─── validateNickname ────────────────────────────────────────────

describe("validateNickname", () => {
  it("accepts valid nickname", () => {
    const result = validateNickname("The Keeper");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("The Keeper");
  });

  it("trims whitespace", () => {
    const result = validateNickname("  hello  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
  });

  it("accepts empty string (means clear)", () => {
    const result = validateNickname("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("");
  });

  it("accepts whitespace-only as empty (clear)", () => {
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
    if (!result.ok) expect(result.error).toContain("newline");
  });

  it("rejects too long nicknames", () => {
    const result = validateNickname("x".repeat(NICKNAME_MAX_LEN + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too long");
  });

  it("accepts nickname at max length", () => {
    const result = validateNickname("x".repeat(NICKNAME_MAX_LEN));
    expect(result.ok).toBe(true);
  });

  it("accepts emojis", () => {
    const result = validateNickname("🦁 Lioness");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("🦁 Lioness");
  });
});

// ─── psiNicknameFile ─────────────────────────────────────────────

describe("psiNicknameFile", () => {
  it("returns ψ/nickname path under repo", () => {
    const result = psiNicknameFile("/home/user/repo");
    expect(result).toBe("/home/user/repo/ψ/nickname");
  });

  it("handles trailing slash in repo path", () => {
    const result = psiNicknameFile("/home/user/repo/");
    expect(result).toContain("ψ/nickname");
  });
});

// ─── readNickname + writeNickname (filesystem) ──────────────────

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readNickname, writeNickname } from "../../src/core/fleet/nicknames";

describe("readNickname + writeNickname", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nick-rw-"));

  it("returns null when file does not exist", () => {
    expect(readNickname(join(tmp, "nonexistent"))).toBeNull();
  });

  it("round-trips: write then read", () => {
    const repo = join(tmp, "repo1");
    mkdirSync(repo, { recursive: true });
    writeNickname(repo, "TestNick");
    expect(readNickname(repo)).toBe("TestNick");
  });

  it("creates ψ directory if missing", () => {
    const repo = join(tmp, "repo2");
    writeNickname(repo, "Auto");
    expect(existsSync(join(repo, "ψ", "nickname"))).toBe(true);
  });

  it("clears nickname by writing empty string", () => {
    const repo = join(tmp, "repo3");
    writeNickname(repo, "First");
    expect(readNickname(repo)).toBe("First");
    writeNickname(repo, "");
    expect(readNickname(repo)).toBeNull();
    expect(existsSync(join(repo, "ψ", "nickname"))).toBe(false);
  });

  it("trims whitespace on read", () => {
    const repo = join(tmp, "repo4");
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(join(repo, "ψ", "nickname"), "  padded  \n", "utf-8");
    expect(readNickname(repo)).toBe("padded");
  });

  it("returns null for empty file", () => {
    const repo = join(tmp, "repo5");
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(join(repo, "ψ", "nickname"), "", "utf-8");
    expect(readNickname(repo)).toBeNull();
  });
});
