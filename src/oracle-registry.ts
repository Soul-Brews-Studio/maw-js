/**
 * Oracle Registry — fleet-wide oracle discovery + cache.
 *
 * Scans ghq root for repos with ψ/ directories (the authoritative signal
 * for "this is an oracle"), merges with fleet config lineage data, and
 * caches to ~/.config/maw/oracles.json.
 *
 * See: Soul-Brews-Studio/maw-js#208
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { CONFIG_DIR, FLEET_DIR } from "./paths";
import { loadConfig } from "./config";

// --- Types ---

export interface OracleEntry {
  org: string;
  repo: string;
  name: string;            // display name: strip trailing -oracle
  local_path: string;
  has_psi: boolean;
  has_fleet_config: boolean;
  budded_from: string | null;
  budded_at: string | null;
  federation_node: string | null;
  detected_at: string;     // ISO8601
}

export interface RegistryCache {
  schema: 1;
  local_scanned_at: string;
  ghq_root: string;
  oracles: OracleEntry[];
}

const CACHE_FILE = join(CONFIG_DIR, "oracles.json");
const STALE_HOURS = 1;

// --- Cache I/O ---

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

export function writeCache(cache: RegistryCache): void {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

export function isCacheStale(cache: RegistryCache | null): boolean {
  if (!cache) return true;
  const scannedAt = new Date(cache.local_scanned_at).getTime();
  const ageMs = Date.now() - scannedAt;
  return ageMs > STALE_HOURS * 3600_000;
}

// --- Fleet config parsing ---

interface FleetLineage {
  repo: string;             // e.g. "Soul-Brews-Studio/mawjs-oracle"
  budded_from: string | null;
  budded_at: string | null;
}

function readFleetLineage(): Map<string, FleetLineage> {
  const map = new Map<string, FleetLineage>();
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      try {
        const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
        const repos: string[] = config.project_repos || [];
        for (const r of repos) {
          map.set(r, {
            repo: r,
            budded_from: config.budded_from || null,
            budded_at: config.budded_at || null,
          });
        }
        // Also check windows for repo references
        for (const w of config.windows || []) {
          if (w.repo && !map.has(w.repo)) {
            map.set(w.repo, {
              repo: w.repo,
              budded_from: config.budded_from || null,
              budded_at: config.budded_at || null,
            });
          }
        }
      } catch { /* invalid fleet file, skip */ }
    }
  } catch { /* fleet dir may not exist */ }
  return map;
}

// --- Local scan ---

function deriveName(repo: string): string {
  return repo.replace(/-oracle$/, "");
}

export function scanLocal(): OracleEntry[] {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const now = new Date().toISOString();
  const fleetLineage = readFleetLineage();
  const entries: OracleEntry[] = [];
  const seen = new Set<string>();

  // Walk ghq root: <ghqRoot>/<org>/<repo>/
  try {
    for (const org of readdirSync(ghqRoot)) {
      const orgPath = join(ghqRoot, org);
      try {
        if (!statSync(orgPath).isDirectory()) continue;
      } catch { continue; }

      for (const repo of readdirSync(orgPath)) {
        const repoPath = join(orgPath, repo);
        try {
          if (!statSync(repoPath).isDirectory()) continue;
        } catch { continue; }

        const key = `${org}/${repo}`;
        const hasPsi = existsSync(join(repoPath, "ψ"));
        const fleetKey = fleetLineage.has(key) ? key : null;
        const endsWithOracle = repo.endsWith("-oracle");

        // Detection rule: ψ/ OR fleet-referenced OR -oracle suffix
        if (!hasPsi && !fleetKey && !endsWithOracle) continue;

        if (seen.has(key)) continue;
        seen.add(key);

        const lineage = fleetKey ? fleetLineage.get(fleetKey)! : null;

        entries.push({
          org,
          repo,
          name: deriveName(repo),
          local_path: repoPath,
          has_psi: hasPsi,
          has_fleet_config: !!fleetKey,
          budded_from: lineage?.budded_from || null,
          budded_at: lineage?.budded_at || null,
          federation_node: null, // populated below if maw.config.json exists
          detected_at: now,
        });
      }
    }
  } catch (e) {
    console.warn(`[oracle-registry] failed to walk ghq root ${ghqRoot}: ${e}`);
  }

  // Enrich with federation node from the current machine's config
  const localNode = config.node || null;
  const agents = config.agents || {};
  for (const entry of entries) {
    // If this oracle's name matches a known agent → use its node
    const agentNode = agents[entry.name];
    if (agentNode) {
      entry.federation_node = agentNode;
    } else if (localNode) {
      // Default: if the oracle is local, it's on this node
      entry.federation_node = localNode;
    }
  }

  // Also add fleet-referenced repos that aren't on disk
  for (const [key, lineage] of fleetLineage) {
    if (!seen.has(key)) {
      const [org, repo] = key.split("/");
      if (org && repo) {
        entries.push({
          org,
          repo,
          name: deriveName(repo),
          local_path: "",
          has_psi: false,
          has_fleet_config: true,
          budded_from: lineage.budded_from || null,
          budded_at: lineage.budded_at || null,
          federation_node: null,
          detected_at: now,
        });
      }
    }
  }

  return entries.sort((a, b) => {
    if (a.org !== b.org) return a.org.localeCompare(b.org);
    return a.name.localeCompare(b.name);
  });
}

// --- Remote scan (GitHub API) ---

export async function scanRemote(orgs?: string[]): Promise<OracleEntry[]> {
  const config = loadConfig();
  const defaultOrgs = config.githubOrgs || ["Soul-Brews-Studio", "laris-co"];
  const targetOrgs = orgs || defaultOrgs;
  const now = new Date().toISOString();
  const entries: OracleEntry[] = [];
  const seen = new Set<string>();

  for (const org of targetOrgs) {
    try {
      // Use gh CLI for auth-handled pagination
      const out = execSync(
        `gh api "/orgs/${org}/repos?per_page=100&type=all" --paginate --jq '.[] | .full_name + " " + .name'`,
        { encoding: "utf-8", timeout: 30000 },
      );

      for (const line of out.trim().split("\n").filter(Boolean)) {
        const [fullName, repoName] = line.split(" ");
        if (!repoName) continue;

        // Detection: -oracle suffix
        if (!repoName.endsWith("-oracle")) continue;

        const key = fullName; // e.g. "Soul-Brews-Studio/mawjs-oracle"
        if (seen.has(key)) continue;
        seen.add(key);

        // Check for ψ/ directory via API (light — just HEAD check)
        let hasPsi = false;
        try {
          execSync(`gh api "/repos/${fullName}/contents/ψ" --silent 2>/dev/null`, { timeout: 5000 });
          hasPsi = true;
        } catch { /* no ψ/ */ }

        entries.push({
          org,
          repo: repoName,
          name: deriveName(repoName),
          local_path: "",
          has_psi: hasPsi,
          has_fleet_config: false,
          budded_from: null,
          budded_at: null,
          federation_node: null,
          detected_at: now,
        });
      }
    } catch (err) {
      console.warn(`[oracle-registry] remote scan failed for ${org}: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Scan local, write cache, return entries */
export function scanAndCache(mode: "local" | "remote" | "both" = "local"): RegistryCache {
  const config = loadConfig();
  const localEntries = mode !== "remote" ? scanLocal() : [];

  const cache: RegistryCache = {
    schema: 1,
    local_scanned_at: new Date().toISOString(),
    ghq_root: config.ghqRoot,
    oracles: localEntries,
  };
  writeCache(cache);
  return cache;
}

/** Full scan: local + remote merged */
export async function scanFull(orgs?: string[]): Promise<RegistryCache> {
  const config = loadConfig();
  const localEntries = scanLocal();
  const remoteEntries = await scanRemote(orgs);

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
    ghq_root: config.ghqRoot,
    oracles: [...merged.values()].sort((a, b) => {
      if (a.org !== b.org) return a.org.localeCompare(b.org);
      return a.name.localeCompare(b.name);
    }),
  };
  writeCache(cache);
  return cache;
}
