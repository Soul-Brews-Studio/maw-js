/**
 * Oracle Registry — fleet-wide oracle discovery + cache.
 *
 * Scans ghq root for repos with ψ/ directories (the authoritative signal
 * for "this is an oracle"), merges with fleet config lineage data, and
 * caches to mawCachePath("oracles.json").
 *
 * See: Soul-Brews-Studio/maw-js#208
 *
 * Sub-modules:
 *   registry-oracle-types.ts        — OracleEntry, RegistryCache types + constants
 *   registry-oracle-cache.ts        — readCache, writeCache, isCacheStale, mergeRegistry
 *   registry-oracle-scan-local.ts   — scanLocal + fleet lineage helpers
 *   registry-oracle-scan-remote.ts  — scanRemote (GitHub API + gh CLI)
 *   registry-oracle-orchestrate.ts  — scanAndCache, scanFull
 */

export type { OracleEntry, RegistryCache } from "./registry-oracle-types";
export { readCache, writeCache, isCacheStale, mergeRegistry } from "./registry-oracle-cache";
export { scanLocal } from "./registry-oracle-scan-local";
export { scanRemote } from "./registry-oracle-scan-remote";
export { scanAndCache, scanFull } from "./registry-oracle-orchestrate";
