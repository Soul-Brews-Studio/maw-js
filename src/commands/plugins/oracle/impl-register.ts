/**
 * maw oracle register <name> — adopt a discovered oracle into the registry.
 *
 * Source priority: fleet config > tmux session > local filesystem.
 *
 * Errors:
 *   - Collision: name already in oracles[] → "already registered"
 *   - Missing: not found in any source → "oracle not found"
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR, FLEET_DIR, listSessions } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
import type { OracleEntry } from "../../../sdk";

const CACHE_FILE = join(CONFIG_DIR, "oracles.json");

export interface RegisterOpts {
  json?: boolean;
}

// ─── Discovery sources ────────────────────────────────────────────────────────

export interface DiscoveredOracle {
  source: "fleet" | "tmux" | "filesystem";
  entry: OracleEntry;
}

export function findInFleet(
  name: string,
  fleetDir: string = FLEET_DIR,
): DiscoveredOracle | null {
  try {
    for (const file of readdirSync(fleetDir).filter((f) => f.endsWith(".json"))) {
      let config: any;
      try {
        config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      } catch { continue; }

      const windows: any[] = config.windows || [];
      const hasThis = windows.some(
        (w) => w.name === `${name}-oracle` || w.name === name,
      );
      if (!hasThis) continue;

      // Derive repo from fleet file or windows
      const repos: string[] = config.project_repos || [];
      const repoFull = repos.find((r) => r.endsWith(`/${name}-oracle`) || r.endsWith(`/${name}`));
      const parts = repoFull ? repoFull.split("/") : [];
      const org = parts[0] || "(unknown)";
      const repo = parts[1] || `${name}-oracle`;
      const now = new Date().toISOString();

      return {
        source: "fleet",
        entry: {
          org,
          repo,
          name,
          local_path: "",
          has_psi: false,
          has_fleet_config: true,
          budded_from: config.budded_from || null,
          budded_at: config.budded_at || null,
          federation_node: null,
          detected_at: now,
        },
      };
    }
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function findInTmux(
  name: string,
  listSessionsFn: typeof listSessions = listSessions,
): Promise<DiscoveredOracle | null> {
  try {
    const sessions = await listSessionsFn();
    for (const s of sessions) {
      for (const w of s.windows) {
        if (w.name === `${name}-oracle` || w.name === name) {
          const now = new Date().toISOString();
          return {
            source: "tmux",
            entry: {
              org: "(unregistered)",
              repo: `${name}-oracle`,
              name,
              local_path: "",
              has_psi: false,
              has_fleet_config: false,
              budded_from: null,
              budded_at: null,
              federation_node: null,
              detected_at: now,
            },
          };
        }
      }
    }
  } catch { /* tmux not running */ }
  return null;
}

export function findInFilesystem(
  name: string,
  reposRoot: string,
): DiscoveredOracle | null {
  try {
    for (const org of readdirSync(reposRoot)) {
      const orgPath = join(reposRoot, org);
      try {
        if (!statSync(orgPath).isDirectory()) continue;
      } catch { continue; }

      for (const candidate of [`${name}-oracle`, name]) {
        const repoPath = join(orgPath, candidate);
        try {
          if (!statSync(repoPath).isDirectory()) continue;
        } catch { continue; }

        const hasPsi = existsSync(join(repoPath, "ψ"));
        const now = new Date().toISOString();
        return {
          source: "filesystem",
          entry: {
            org,
            repo: candidate,
            name,
            local_path: repoPath,
            has_psi: hasPsi,
            has_fleet_config: false,
            budded_from: null,
            budded_at: null,
            federation_node: null,
            detected_at: now,
          },
        };
      }
    }
  } catch { /* ghq root may not exist */ }
  return null;
}

// ─── Raw registry I/O ─────────────────────────────────────────────────────────

function readRaw(file: string): Record<string, unknown> {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch { /* fall through */ }
  return {};
}

function writeRaw(file: string, data: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export async function cmdOracleRegister(
  name: string,
  opts: RegisterOpts = {},
  deps: {
    readRawCache?: () => Record<string, unknown>;
    writeRawCache?: (data: Record<string, unknown>) => void;
    findInFleetFn?: (name: string) => DiscoveredOracle | null;
    findInTmuxFn?: (name: string) => Promise<DiscoveredOracle | null>;
    findInFilesystemFn?: (name: string) => DiscoveredOracle | null;
  } = {},
): Promise<void> {
  if (!name) throw new Error("register requires a name: maw oracle register <name>");

  const readRawCache = deps.readRawCache ?? (() => readRaw(CACHE_FILE));
  const writeRawCache = deps.writeRawCache ?? ((data) => writeRaw(CACHE_FILE, data));

  const rawCache = readRawCache();
  const oracles: OracleEntry[] = (rawCache.oracles as OracleEntry[] | undefined) ?? [];

  // Collision check
  const existing = oracles.find((e) => e.name === name);
  if (existing) {
    throw new Error(`oracle '${name}' is already registered (org: ${existing.org})`);
  }

  // Discovery — fleet > tmux > filesystem
  const reposRoot = join(getGhqRoot(), "github.com");

  const fleetFn = deps.findInFleetFn ?? findInFleet;
  const tmuxFn = deps.findInTmuxFn ?? findInTmux;
  const fsFn = deps.findInFilesystemFn ?? ((n) => findInFilesystem(n, reposRoot));

  const discovered =
    fleetFn(name) ??
    (await tmuxFn(name)) ??
    fsFn(name);

  if (!discovered) {
    throw new Error(
      `oracle '${name}' not found in fleet, tmux, or filesystem — try: maw oracle scan`,
    );
  }

  // Add to registry
  oracles.push(discovered.entry);
  rawCache.oracles = oracles;
  writeRawCache(rawCache);

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, registered: discovered.entry, source: discovered.source }, null, 2));
    return;
  }

  console.log(`\n  \x1b[32m✓\x1b[0m Registered \x1b[36m${name}\x1b[0m`);
  console.log(`  Source:  ${discovered.source}`);
  console.log(`  Org:     ${discovered.entry.org}`);
  console.log(`  Repo:    ${discovered.entry.repo}`);
  if (discovered.entry.local_path) {
    console.log(`  Path:    ${discovered.entry.local_path}`);
  }
  console.log();
}
