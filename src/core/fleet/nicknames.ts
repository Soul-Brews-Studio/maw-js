/**
 * Oracle nickname storage — Phase 1 of #643.
 *
 * Authoritative: `<oracle-repo>/ψ/nickname` (plain UTF-8, trimmed on read).
 * Cache:        `<resolveHome()>/nicknames.json` — read-through, non-authoritative.
 *
 * See docs/fleet/nickname-design.md for the full spec (precedence, edge cases).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { resolveHome } from "../paths";

export const NICKNAME_MAX_LEN = 64;

export interface NicknameCache {
  schema: 1;
  nicknames: Record<string, string>;
}

export function cacheFile(): string {
  return join(resolveHome(), "nicknames.json");
}

export function psiNicknameFile(repoPath: string): string {
  return join(repoPath, "ψ", "nickname");
}

export interface ValidatedNickname {
  ok: true;
  value: string; // trimmed; empty means clear
}
export interface InvalidNickname {
  ok: false;
  error: string;
}

export function validateNickname(raw: string): ValidatedNickname | InvalidNickname {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: "" };
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: "nickname must be a single line (no newlines)" };
  }
  if (trimmed.length > NICKNAME_MAX_LEN) {
    return {
      ok: false,
      error: `nickname too long (${trimmed.length} > ${NICKNAME_MAX_LEN})`,
    };
  }
  return { ok: true, value: trimmed };
}

// ─── Per-oracle file (authoritative) ──────────────────────────────────────────

export function readNickname(repoPath: string): string | null {
  const file = psiNicknameFile(repoPath);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/**
 * Write nickname to the oracle's ψ/nickname file. Empty string clears.
 * Caller is responsible for validating input via `validateNickname` first.
 */
export function writeNickname(repoPath: string, nickname: string): void {
  const file = psiNicknameFile(repoPath);
  if (nickname === "") {
    if (existsSync(file)) rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, nickname + "\n", "utf-8");
}

// ─── Cache (read-through, non-authoritative) ──────────────────────────────────

export function readCache(): NicknameCache {
  const file = cacheFile();
  if (!existsSync(file)) return { schema: 1, nicknames: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object" && parsed.nicknames) {
      return { schema: 1, nicknames: parsed.nicknames };
    }
  } catch {
    // malformed — caller gets empty cache
  }
  return { schema: 1, nicknames: {} };
}

export function writeCache(cache: NicknameCache): void {
  const file = cacheFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

export function getCachedNickname(name: string): string | null {
  const cache = readCache();
  const v = cache.nicknames[name];
  return v ?? null;
}

export function setCachedNickname(name: string, nickname: string): void {
  const cache = readCache();
  if (nickname === "") {
    delete cache.nicknames[name];
  } else {
    cache.nicknames[name] = nickname;
  }
  writeCache(cache);
}

/**
 * Resolve nickname for an oracle: cache first, then on-disk file.
 * Returns null when neither source has a value.
 */
export function resolveNickname(
  name: string,
  repoPath: string | null | undefined,
): string | null {
  const cached = getCachedNickname(name);
  if (cached !== null) return cached;
  if (!repoPath) return null;
  const onDisk = readNickname(repoPath);
  return onDisk;
}
