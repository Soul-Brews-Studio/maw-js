import { join, resolve, dirname } from "path";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { mawConfigDir, mawRuntimeHomeDir } from "./xdg";

export const MAW_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/**
 * Resolve the maw instance home directory.
 *
 * - When `MAW_HOME` is set, returns that path. This is the per-instance root
 *   used by `maw serve --as <name>` to give each instance isolated state.
 * - Otherwise returns the default singleton root at `~/.maw/`.
 *
 * Non-serve verbs pick up `MAW_HOME` via the env var only — there is no
 * `--instance` flag on individual plugins yet (issue #566 follow-up).
 */
export function resolveHome(): string {
  return mawRuntimeHomeDir();
}

/**
 * CONFIG_DIR resolution precedence:
 *   1. `MAW_HOME` set (instance mode) → `<MAW_HOME>/config`
 *   2. `MAW_CONFIG_DIR` env override (legacy)
 *   3. Default singleton `~/.config/maw/`
 *
 * Evaluated once at import time. Callers that need per-instance state MUST
 * ensure `MAW_HOME` is set before any import of this module. The CLI does
 * this in src/cli.ts before any state-touching import is resolved.
 */
export const CONFIG_DIR = mawConfigDir();
export const FLEET_DIR = join(CONFIG_DIR, "fleet");
export const CONFIG_FILE = join(CONFIG_DIR, "maw.config.json");
export const CONFIG_WEIGHTED_FILE = join(CONFIG_DIR, "maw.config.50.json");

const CONFIG_FILE_REGEX = /^maw\.config\.(\d+)(\.local)?\.json$/;

export type ConfigScope = "system" | "user" | "project" | "legacy";

export interface DiscoveredConfig {
  path: string;
  weight: number;
  isLocal: boolean;
  scope: ConfigScope;
  scopeRank: number;
  depth: number;
  mtimeMs: number;
}

// Ensure dirs exist on first import
mkdirSync(FLEET_DIR, { recursive: true });

function scanConfigDir(dir: string, scope: ConfigScope, scopeRank: number, depth = 0): DiscoveredConfig[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => {
        const match = name.match(CONFIG_FILE_REGEX);
        if (!match) return null;
        const path = join(dir, name);
        return {
          path,
          weight: Number.parseInt(match[1]!, 10),
          isLocal: Boolean(match[2]),
          scope,
          scopeRank,
          depth,
          mtimeMs: statSync(path).mtimeMs,
        } satisfies DiscoveredConfig;
      })
      .filter((item): item is DiscoveredConfig => item !== null);
  } catch {
    return [];
  }
}

/**
 * Discover maw config layers for a cwd-aware invocation.
 *
 * Phase 1 intentionally skips /etc/maw managed config. The global layer still
 * honors CONFIG_DIR/MAW_HOME/MAW_CONFIG_DIR. Legacy maw.config.json is loaded
 * as weight 50 only when no weighted user-global file exists.
 */
export function discoverConfigs(cwd = process.cwd()): DiscoveredConfig[] {
  const found: DiscoveredConfig[] = [];

  const userWeighted = scanConfigDir(CONFIG_DIR, "user", 20, 0);
  found.push(...userWeighted);
  if (userWeighted.length === 0 && existsSync(CONFIG_FILE)) {
    try {
      found.push({
        path: CONFIG_FILE,
        weight: 50,
        isLocal: false,
        scope: "legacy",
        scopeRank: 20,
        depth: 0,
        mtimeMs: statSync(CONFIG_FILE).mtimeMs,
      });
    } catch {
      // Ignore unreadable legacy config; loadConfig will fall back to defaults.
    }
  }

  const chain: string[] = [];
  let dir = resolve(cwd);
  for (let i = 0; i < 32; i += 1) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  chain.reverse();
  chain.forEach((entry, index) => {
    found.push(...scanConfigDir(join(entry, ".maw"), "project", 30 + index, index));
  });

  return found.sort((a, b) =>
    a.weight - b.weight ||
    a.scopeRank - b.scopeRank ||
    Number(a.isLocal) - Number(b.isLocal) ||
    a.path.localeCompare(b.path)
  );
}
