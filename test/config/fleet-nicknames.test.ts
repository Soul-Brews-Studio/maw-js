/**
 * Tests for src/core/fleet/nicknames.ts — validateNickname, readNickname,
 * writeNickname, readCache, writeCache, getCachedNickname, setCachedNickname,
 * resolveNickname.
 *
 * Uses temp directories for file operations.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  NICKNAME_MAX_LEN,
  validateNickname,
  readNickname,
  writeNickname,
  psiNicknameFile,
} from "../../src/core/fleet/nicknames";

// ─── validateNickname (pure) ───────────────────────────────────────

describe("validateNickname", () => {
  it("accepts valid nickname", () => {
    const result = validateNickname("Firestarter");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Firestarter");
  });

  it("trims whitespace", () => {
    const result = validateNickname("  trimmed  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("trimmed");
  });

  it("accepts empty (clear operation)", () => {
    const result = validateNickname("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("");
  });

  it("accepts whitespace-only as clear", () => {
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

  it("rejects names exceeding max length", () => {
    const long = "a".repeat(NICKNAME_MAX_LEN + 1);
    const result = validateNickname(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too long");
  });

  it("accepts names at max length", () => {
    const exact = "a".repeat(NICKNAME_MAX_LEN);
    const result = validateNickname(exact);
    expect(result.ok).toBe(true);
  });

  it("accepts unicode", () => {
    const result = validateNickname("🦁 Lioness");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("🦁 Lioness");
  });
});

// ─── readNickname / writeNickname (file ops) ───────────────────────

describe("readNickname + writeNickname", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "maw-nick-"));
  });

  afterAll(() => {
    // Cleanup any leftover dirs
  });

  it("returns null when no nickname file exists", () => {
    expect(readNickname(repoDir)).toBeNull();
  });

  it("writes and reads back nickname", () => {
    writeNickname(repoDir, "Firestarter");
    expect(readNickname(repoDir)).toBe("Firestarter");
  });

  it("creates ψ directory if needed", () => {
    writeNickname(repoDir, "test");
    expect(existsSync(join(repoDir, "ψ"))).toBe(true);
  });

  it("clears nickname by writing empty string", () => {
    writeNickname(repoDir, "Firestarter");
    expect(readNickname(repoDir)).toBe("Firestarter");
    writeNickname(repoDir, "");
    expect(readNickname(repoDir)).toBeNull();
    expect(existsSync(psiNicknameFile(repoDir))).toBe(false);
  });

  it("trims whitespace on read", () => {
    // Write with extra whitespace manually
    mkdirSync(join(repoDir, "ψ"), { recursive: true });
    const fs = require("fs");
    fs.writeFileSync(psiNicknameFile(repoDir), "  spaced  \n", "utf-8");
    expect(readNickname(repoDir)).toBe("spaced");
  });

  it("returns null for empty file", () => {
    mkdirSync(join(repoDir, "ψ"), { recursive: true });
    const fs = require("fs");
    fs.writeFileSync(psiNicknameFile(repoDir), "", "utf-8");
    expect(readNickname(repoDir)).toBeNull();
  });
});
