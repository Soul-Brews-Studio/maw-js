/**
 * registry-oracle-orchestrate — scanAndCache and scanFull entry points.
 *
 * Composes local + remote scan results and writes the merged cache.
 */

import { getGhqRoot } from "../../config/ghq-root";
import type { OracleEntry, RegistryCache } from "./registry-oracle-types";
import { writeCache } from "./registry-oracle-cache";
import { scanLocal } from "./registry-oracle-scan-local";
import { scanRemote } from "./registry-oracle-scan-remote";

/** Scan local, write cache, return entries. Verbose-by-default (alpha.74). */
export function scanAndCache(mode: "local" | "remote" | "both" = "local", verbose = true): RegistryCache {
  const localEntries = mode !== "remote" ? scanLocal(verbose) : [];

  const cache: RegistryCache = {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: getGhqRoot(),
    oracles: localEntries,
  };
  writeCache(cache);
  return cache;
}

/** Full scan: local + remote merged. Verbose-by-default (alpha.74). */
export async function scanFull(orgs?: string[], verbose = true): Promise<RegistryCache> {
  if (verbose) console.log(`  \x1b[90m⏳ scanning local...\x1b[0m`);
  const localEntries = scanLocal(verbose);
  if (verbose) console.log(`  \x1b[90m  ${localEntries.length} local oracles found\x1b[0m`);
  const remoteEntries = await scanRemote(orgs, verbose);

  // Merge: local takes priority, remote fills gaps
  const merged = new Map<string, OracleEntry>();
  for (const e of localEntries) merged.set(`${e.org}/${e.repo}`, e);
  for (const e of remoteEntries) {
    const key = `${e.org}/${e.repo}`;
    if (!merged.has(key)) {
      merged.set(key, e);
    } else {
      // Enrich local with remote ψ/ check if local didn't have it
      const local = merged.get(key)!;
      if (!local.has_psi && e.has_psi) local.has_psi = true;
    }
  }

  const cache: RegistryCache = {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: getGhqRoot(),
    oracles: [...merged.values()].sort((a, b) => {
      if (a.org !== b.org) return a.org.localeCompare(b.org);
      return a.name.localeCompare(b.name);
    }),
  };
  writeCache(cache);
  return cache;
}
