/**
 * registry-oracle-cache — cache I/O for the oracle registry.
 *
 * readCache, writeCache, isCacheStale, mergeRegistry.
 * No network or filesystem scanning — only the oracles.json cache file.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { RegistryCache } from "./registry-oracle-types";
import { CACHE_FILE, STALE_HOURS } from "./registry-oracle-types";

export function readCache(): RegistryCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (raw.schema !== 1) return null;
    return raw as RegistryCache;
  } catch {
    return null;
  }
}

/**
 * Pure merge helper: overlay a fresh RegistryCache on top of whatever was
 * already on disk, preserving top-level keys the scanner doesn't manage
 * (e.g. `leaves[]` from legacy tiny-bud registration — deprecated, see #209).
 *
 * Scanners own `schema`, `local_scanned_at`, `ghq_root`, `oracles`. Anything
 * else passes through untouched. Exported for direct unit testing; no I/O.
 */
export function mergeRegistry(
  existing: unknown,
  cache: RegistryCache,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...cache };
}

/**
 * Write the cache, preserving any unknown top-level keys from `targetFile`
 * (or the real CACHE_FILE by default — the override exists for tests).
 */
export function writeCache(cache: RegistryCache, targetFile: string = CACHE_FILE): void {
  let existing: unknown = null;
  try {
    if (existsSync(targetFile)) {
      existing = JSON.parse(readFileSync(targetFile, "utf-8"));
    }
  } catch { /* malformed existing file — fall back to writing fresh */ }

  const merged = mergeRegistry(existing, cache);
  // lgtm[js/file-system-race] — PRIVATE-PATH: fleet registry cache under ~/.maw/, see docs/security/file-system-race-stance.md
  writeFileSync(targetFile, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

export function isCacheStale(cache: RegistryCache | null): boolean {
  if (!cache) return true;
  const scannedAt = new Date(cache.local_scanned_at).getTime();
  const ageMs = Date.now() - scannedAt;
  return ageMs > STALE_HOURS * 3600_000;
}
