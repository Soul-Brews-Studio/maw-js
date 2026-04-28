/**
 * Tests for src/core/fleet/nicknames.ts — filesystem functions.
 * Uses a real temp directory for isolation.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readNickname,
  writeNickname,
  psiNicknameFile,
} from "../../src/core/fleet/nicknames";

const TMP = join(tmpdir(), `maw-nick-test-${Date.now()}`);

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

function repoDir(name: string): string {
  const d = join(TMP, name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("psiNicknameFile", () => {
  it("returns path under ψ/nickname", () => {
    const p = psiNicknameFile("/some/repo");
    expect(p).toContain("ψ");
    expect(p).toContain("nickname");
    expect(p.startsWith("/some/repo")).toBe(true);
  });
});

describe("readNickname", () => {
  it("returns null when no file exists", () => {
    const repo = repoDir("no-nick");
    expect(readNickname(repo)).toBeNull();
  });

  it("reads nickname from ψ/nickname", () => {
    const repo = repoDir("has-nick");
    const file = psiNicknameFile(repo);
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(file, "Sparky\n", "utf-8");
    expect(readNickname(repo)).toBe("Sparky");
  });

  it("trims whitespace", () => {
    const repo = repoDir("trim-nick");
    const file = psiNicknameFile(repo);
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(file, "  Blaze  \n\n", "utf-8");
    expect(readNickname(repo)).toBe("Blaze");
  });

  it("returns null for empty file", () => {
    const repo = repoDir("empty-nick");
    const file = psiNicknameFile(repo);
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(file, "", "utf-8");
    expect(readNickname(repo)).toBeNull();
  });

  it("returns null for whitespace-only file", () => {
    const repo = repoDir("ws-nick");
    const file = psiNicknameFile(repo);
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(file, "   \n  \n", "utf-8");
    expect(readNickname(repo)).toBeNull();
  });
});

describe("writeNickname", () => {
  it("creates ψ/nickname with content", () => {
    const repo = repoDir("write-nick");
    writeNickname(repo, "Phoenix");
    const file = psiNicknameFile(repo);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8").trim()).toBe("Phoenix");
  });

  it("creates ψ directory if missing", () => {
    const repo = repoDir("mkdir-nick");
    writeNickname(repo, "Ember");
    expect(existsSync(join(repo, "ψ"))).toBe(true);
  });

  it("removes file on empty string", () => {
    const repo = repoDir("clear-nick");
    writeNickname(repo, "Temp");
    expect(existsSync(psiNicknameFile(repo))).toBe(true);
    writeNickname(repo, "");
    expect(existsSync(psiNicknameFile(repo))).toBe(false);
  });

  it("overwrites existing nickname", () => {
    const repo = repoDir("overwrite-nick");
    writeNickname(repo, "First");
    writeNickname(repo, "Second");
    expect(readNickname(repo)).toBe("Second");
  });

  it("no-op when clearing non-existent file", () => {
    const repo = repoDir("noop-clear");
    writeNickname(repo, ""); // Should not throw
    expect(existsSync(psiNicknameFile(repo))).toBe(false);
  });
});
