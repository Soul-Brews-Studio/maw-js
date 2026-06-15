/**
 * registry-oracle-scan-local — local ghq filesystem scan.
 *
 * Walks <ghqRoot>/<org>/<repo>/ detecting oracles by:
 *   - presence of ψ/ directory
 *   - fleet config lineage reference
 *   - -oracle suffix in repo name
 *
 * Also adds fleet-referenced repos not found on disk.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fleetDirsForRead } from "./paths";
import { loadConfig } from "../../config";
import type { MawConfig } from "../../config/types";
import { getGhqRoot } from "../../config/ghq-root";
import type { OracleEntry } from "./registry-oracle-types";

// ---------- Fleet lineage parsing ----------

interface FleetLineage {
  repo: string;             // e.g. "Soul-Brews-Studio/mawjs-oracle"
  budded_from: string | null;
  budded_at: string | null;
}


function isLikelyHostName(segment: string): boolean {
  if (segment === "github.com") return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(segment);
}

function isArchivedSegment(segment: string): boolean {
  return /^_?\.?archive(?:d)?$/i.test(segment);
}

function normalizeFleetRepoRef(ref: unknown, source: string): string {
  if (typeof ref !== "string") {
    throw new Error(`invalid fleet repo reference in ${source}: expected string, got ${typeof ref}`);
  }
  const normalized = ref
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^github\.com\//i, "");
  const parsed = parseFleetRepoSlug(normalized);
  if (!parsed) {
    throw new Error(`invalid fleet repo reference in ${source}: ${ref}`);
  }
  return `${parsed.org}/${parsed.repo}`;
}

function warnInvalidFleetRepoRef(message: string): void {
  console.warn(`[oracle-registry] ${message}`);
}

function addFleetLineageConfig(map: Map<string, FleetLineage>, config: any): void {
  const repos: unknown[] = config.project_repos || [];
  for (const r of repos) {
    const repoRef = normalizeFleetRepoRef(r, "project_repos");
    map.set(repoRef, {
      repo: repoRef,
      budded_from: config.budded_from || null,
      budded_at: config.budded_at || null,
    });
  }
  // Also check windows for repo references
  for (const w of config.windows || []) {
    if (!w.repo) continue;
    try {
      const repoRef = normalizeFleetRepoRef(w.repo, "windows[].repo");
      if (!map.has(repoRef)) {
        map.set(repoRef, {
          repo: repoRef,
          budded_from: config.budded_from || null,
          budded_at: config.budded_at || null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const windowName = typeof w.name === "string" && w.name ? ` '${w.name}'` : "";
      warnInvalidFleetRepoRef(`skipping invalid fleet window${windowName}: ${message}`);
    }
  }
}

/** @internal */
export function readFleetLineage(fleetDir?: string | string[]): Map<string, FleetLineage> {
  const map = new Map<string, FleetLineage>();
  const seenFiles = new Set<string>();
  const dirs = Array.isArray(fleetDir) ? fleetDir : fleetDir ? [fleetDir] : fleetDirsForRead();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    } catch {
      // Missing/unreadable fleet dirs are optional read locations; malformed
      // files inside a readable dir are not optional and must fail loud.
      continue;
    }
    for (const file of files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      const path = join(dir, file);
      try {
        addFleetLineageConfig(map, JSON.parse(readFileSync(path, "utf-8")));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid fleet lineage JSON ${path}: ${message}`);
      }
    }
  }
  return map;
}

/** @internal */
export function deriveName(repo: string): string {
  return repo.replace(/-oracle$/, "");
}

// ---------- Local scan ----------

interface ScanLocalDeps {
  config?: Pick<MawConfig, "node" | "agents">;
  fleetDir?: string;
  fleetDirs?: string[];
  ghqRoot?: string;
  now?: string;
  fleetLineage?: Map<string, FleetLineage>;
}

function parseFleetRepoSlug(key: string): { org: string; repo: string } | null {
  const parts = key.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [org, repo] = parts;
  if (!org || !repo) return null;
  if (isLikelyHostName(org) || isArchivedSegment(org) || isArchivedSegment(repo)) return null;
  return { org, repo };
}

/**
 * Scan local ghq for oracles. Verbose-by-default per user direction
 * (alpha.74, 2026-04-16) — pass verbose=false for the terse summary.
 * See `feedback_verbose_by_default`.
 */
export function scanLocal(verbose = true, deps: ScanLocalDeps = {}): OracleEntry[] {
  const config = deps.config ?? loadConfig();
  const fleetDirs = deps.fleetDirs ?? (deps.fleetDir ? [deps.fleetDir] : fleetDirsForRead());
  const fleetSource = fleetDirs.join(", ");
  const reposRoot = join(deps.ghqRoot ?? getGhqRoot(), "github.com");
  const now = deps.now ?? new Date().toISOString();
  const fleetLineage = deps.fleetLineage ?? readFleetLineage(fleetDirs);
  const entries: OracleEntry[] = [];
  const seen = new Set<string>();

  if (verbose) {
    console.log(`  \x1b[90m⏳ scanning repos root: ${reposRoot}\x1b[0m`);
    console.log(`  \x1b[90m  fleet lineage: ${fleetLineage.size} entries from ${fleetSource}\x1b[0m`);
  }

  // Walk reposRoot: <reposRoot>/<org>/<repo>/
  try {
    for (const org of readdirSync(reposRoot)) {
      if (isLikelyHostName(org) || isArchivedSegment(org)) {
        if (verbose) console.log(`  \x1b[90m  ⏭ skipping non-repo org segment: ${org}\x1b[0m`);
        continue;
      }
      const orgPath = join(reposRoot, org);
      try {
        if (!statSync(orgPath).isDirectory()) continue;
      } catch { continue; }

      let repoCount = 0;
      let oracleCount = 0;

      for (const repo of readdirSync(orgPath)) {
        if (isArchivedSegment(repo)) continue;
        const repoPath = join(orgPath, repo);
        try {
          if (!statSync(repoPath).isDirectory()) continue;
        } catch { continue; }
        repoCount++;

        const key = `${org}/${repo}`;
        const hasPsi = existsSync(join(repoPath, "ψ"));
        const fleetKey = fleetLineage.has(key) ? key : null;
        const endsWithOracle = repo.endsWith("-oracle");

        // Detection rule: ψ/ OR fleet-referenced OR -oracle suffix
        if (!hasPsi && !fleetKey && !endsWithOracle) continue;

        if (seen.has(key)) continue;
        seen.add(key);
        oracleCount++;

        const lineage = fleetKey ? fleetLineage.get(fleetKey)! : null;

        if (verbose) {
          // Show WHY this was detected — transparency for the user
          const sources: string[] = [];
          if (hasPsi) sources.push("\x1b[32mψ\x1b[0m");
          if (fleetKey) sources.push("\x1b[36mfleet\x1b[0m");
          if (endsWithOracle) sources.push("\x1b[33m-oracle\x1b[0m");
          console.log(`  \x1b[90m  + ${key}\x1b[0m [${sources.join(" ")}]`);
        }

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

      if (verbose && repoCount > 0) {
        console.log(`  \x1b[90m⏳ ${org}: ${repoCount} repos, ${oracleCount} oracles\x1b[0m`);
      }
    }
  } catch (e) {
    console.warn(`[oracle-registry] failed to walk repos root ${reposRoot}: ${e}`);
  }

  // Enrich with federation node from the current machine's config
  const localNode = config.node || null;
  const agents = config.agents || {};
  let fedEnriched = 0;
  for (const entry of entries) {
    // If this oracle's name matches a known agent → use its node
    const agentNode = agents[entry.name];
    if (agentNode) {
      entry.federation_node = agentNode;
      fedEnriched++;
    } else if (localNode) {
      // Default: if the oracle is local, it's on this node
      entry.federation_node = localNode;
    }
  }
  if (verbose && fedEnriched > 0) {
    console.log(`  \x1b[90m  federation-enriched ${fedEnriched} from config.agents\x1b[0m`);
  }

  // Also add fleet-referenced repos that aren't on disk
  let fleetOnly = 0;
  for (const [key, lineage] of fleetLineage) {
    if (!seen.has(key)) {
      const parsed = parseFleetRepoSlug(key);
      if (parsed) {
        const { org, repo } = parsed;
        fleetOnly++;
        if (verbose) {
          console.log(`  \x1b[90m  + ${key}\x1b[0m [\x1b[36mfleet-only\x1b[0m] (not cloned)`);
        }
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
  if (verbose && fleetOnly > 0) {
    console.log(`  \x1b[90m  ${fleetOnly} fleet-only oracles (referenced but not cloned)\x1b[0m`);
  }

  return entries.sort((a, b) => {
    if (a.org !== b.org) return a.org.localeCompare(b.org);
    return a.name.localeCompare(b.name);
  });
}
