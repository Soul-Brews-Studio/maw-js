import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  validateNickname,
  readNickname,
  writeNickname,
  resolveNickname,
  setCachedNickname,
  readCache,
  cacheFile,
  psiNicknameFile,
  NICKNAME_MAX_LEN,
} from "../../../core/fleet/nicknames";

// ─── Sandbox ──────────────────────────────────────────────────────────────────

let prevMawHome: string | undefined;
let sandbox: string;
let home: string;      // $MAW_HOME — holds the cache
let repo: string;      // fake oracle repo with ψ/

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "maw-nickname-"));
  home = join(sandbox, "home");
  repo = join(sandbox, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "ψ"), { recursive: true });
  prevMawHome = process.env.MAW_HOME;
  process.env.MAW_HOME = home;
});

afterEach(() => {
  if (prevMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = prevMawHome;
  rmSync(sandbox, { recursive: true, force: true });
});

// ─── validateNickname ─────────────────────────────────────────────────────────

describe("validateNickname", () => {
  it("accepts a simple label", () => {
    const v = validateNickname("Moe");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toBe("Moe");
  });

  it("trims whitespace", () => {
    const v = validateNickname("  Moe  ");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toBe("Moe");
  });

  it("whitespace-only collapses to empty (clear)", () => {
    const v = validateNickname("   ");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toBe("");
  });

  it("rejects newline", () => {
    const v = validateNickname("foo\nbar");
    expect(v.ok).toBe(false);
  });

  it("rejects overlength", () => {
    const v = validateNickname("a".repeat(NICKNAME_MAX_LEN + 1));
    expect(v.ok).toBe(false);
  });

  it("accepts max length", () => {
    const v = validateNickname("a".repeat(NICKNAME_MAX_LEN));
    expect(v.ok).toBe(true);
  });
});

// ─── ψ/nickname file round-trip ──────────────────────────────────────────────

describe("readNickname / writeNickname", () => {
  it("returns null when file absent", () => {
    expect(readNickname(repo)).toBeNull();
  });

  it("round-trips a nickname", () => {
    writeNickname(repo, "Moe");
    expect(readNickname(repo)).toBe("Moe");
    // file lives under ψ/
    expect(existsSync(psiNicknameFile(repo))).toBe(true);
    expect(readFileSync(psiNicknameFile(repo), "utf-8")).toBe("Moe\n");
  });

  it("empty string clears the file", () => {
    writeNickname(repo, "Moe");
    expect(readNickname(repo)).toBe("Moe");
    writeNickname(repo, "");
    expect(readNickname(repo)).toBeNull();
    expect(existsSync(psiNicknameFile(repo))).toBe(false);
  });

  it("trims trailing newline on read", () => {
    writeFileSync(psiNicknameFile(repo), "Moe\n\n");
    expect(readNickname(repo)).toBe("Moe");
  });

  it("empty file reads as null", () => {
    writeFileSync(psiNicknameFile(repo), "   \n");
    expect(readNickname(repo)).toBeNull();
  });

  it("creates ψ/ directory if missing", () => {
    const freshRepo = join(sandbox, "fresh-repo");
    mkdirSync(freshRepo);
    writeNickname(freshRepo, "Moe");
    expect(readNickname(freshRepo)).toBe("Moe");
  });
});

// ─── Cache ────────────────────────────────────────────────────────────────────

describe("nicknames cache", () => {
  it("reads empty cache when file absent", () => {
    const c = readCache();
    expect(c.schema).toBe(1);
    expect(c.nicknames).toEqual({});
  });

  it("setCachedNickname writes and reads back", () => {
    setCachedNickname("foo", "Mo");
    const c = readCache();
    expect(c.nicknames.foo).toBe("Mo");
    // cache file lives under MAW_HOME
    expect(cacheFile().startsWith(home)).toBe(true);
  });

  it("setCachedNickname with empty string removes entry", () => {
    setCachedNickname("foo", "Mo");
    setCachedNickname("foo", "");
    const c = readCache();
    expect(c.nicknames.foo).toBeUndefined();
  });

  it("malformed cache file falls back to empty", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(cacheFile(), "{not json");
    const c = readCache();
    expect(c.nicknames).toEqual({});
  });
});

// ─── resolveNickname precedence ──────────────────────────────────────────────

describe("resolveNickname", () => {
  it("returns null when both sources empty", () => {
    expect(resolveNickname("foo", repo)).toBeNull();
  });

  it("falls back to on-disk when cache empty", () => {
    writeNickname(repo, "Moe");
    expect(resolveNickname("foo", repo)).toBe("Moe");
  });

  it("cache wins over on-disk (read-through)", () => {
    writeNickname(repo, "DiskValue");
    setCachedNickname("foo", "CacheValue");
    expect(resolveNickname("foo", repo)).toBe("CacheValue");
  });

  it("handles null repoPath (uncloned oracle)", () => {
    setCachedNickname("foo", "CacheOnly");
    expect(resolveNickname("foo", null)).toBe("CacheOnly");
    expect(resolveNickname("bar", null)).toBeNull();
  });
});
