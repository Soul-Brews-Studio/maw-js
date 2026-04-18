/**
 * Registry manifest fetcher (#515).
 *
 * Fetches the community registry manifest from `https://maw.soulbrews.studio/registry.json`
 * (override via `MAW_REGISTRY_URL`), caches it to `~/.maw/registry-cache.json`
 * with a 5-minute TTL, and falls back to the cache on network failure.
 *
 * The registry only resolves "where to fetch <name>"; `plugins.lock` (see lock.ts)
 * remains the adversarial sha256 pin. Registry trust is advisory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const DEFAULT_REGISTRY_URL = "https://maw.soulbrews.studio/registry.json";
export const CACHE_TTL_MS = 5 * 60 * 1000;

export interface RegistryEntry {
  version: string;
  source: string;
  sha256: string | null;
  summary: string;
  author: string;
  license: string;
  homepage?: string;
  addedAt: string;
}

export interface RegistryManifest {
  schemaVersion: 1;
  updated: string;
  plugins: Record<string, RegistryEntry>;
}

export function registryUrl(override?: string): string {
  return override || process.env.MAW_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

export function cachePath(): string {
  return process.env.MAW_REGISTRY_CACHE || join(homedir(), ".maw", "registry-cache.json");
}

interface CacheFile {
  url: string;
  fetchedAt: string;
  manifest: RegistryManifest;
}

function isManifest(v: unknown): v is RegistryManifest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 1) return false;
  if (typeof o.updated !== "string") return false;
  if (!o.plugins || typeof o.plugins !== "object" || Array.isArray(o.plugins)) return false;
  return true;
}

function readCache(): CacheFile | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
    if (!isManifest(parsed?.manifest)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(url: string, manifest: RegistryManifest): void {
  const p = cachePath();
  mkdirSync(dirname(p), { recursive: true });
  const body: CacheFile = { url, fetchedAt: new Date().toISOString(), manifest };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}

export function isCacheFresh(cache: CacheFile, url: string, now = Date.now()): boolean {
  if (cache.url !== url) return false;
  const age = now - new Date(cache.fetchedAt).getTime();
  return age >= 0 && age < CACHE_TTL_MS;
}

/**
 * Fetch the registry manifest, honoring a 5-min on-disk cache.
 *
 * - Fresh cache hit → return cached.
 * - Stale or missing → attempt network; on success, refresh cache; on failure,
 *   warn and return stale cache if any. Only throws when both network and
 *   cache are unavailable.
 */
export async function getRegistry(url?: string): Promise<RegistryManifest> {
  const target = registryUrl(url);
  const cache = readCache();
  if (cache && isCacheFresh(cache, target)) return cache.manifest;

  try {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const parsed = await res.json();
    if (!isManifest(parsed)) throw new Error("invalid registry: missing schemaVersion=1/plugins");
    writeCache(target, parsed);
    return parsed;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (cache && cache.url === target) {
      process.stderr.write(`\x1b[33m!\x1b[0m registry fetch failed (${msg}); using cached copy from ${cache.fetchedAt}\n`);
      return cache.manifest;
    }
    throw new Error(`registry fetch failed: ${msg}\n  url: ${target}\n  (no cache available)`);
  }
}
