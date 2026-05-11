import { join, resolve, dirname } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

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
  return process.env.MAW_HOME || join(homedir(), ".maw");
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
export const CONFIG_DIR = process.env.MAW_HOME
  ? join(process.env.MAW_HOME, "config")
  : (process.env.MAW_CONFIG_DIR || join(homedir(), ".config", "maw"));
export const FLEET_DIR = join(CONFIG_DIR, "fleet");
export const CONFIG_FILE = join(CONFIG_DIR, "maw.config.json");

/**
 * Call-time variants of CONFIG_DIR / FLEET_DIR / CONFIG_FILE. (#1190 / #1200)
 *
 * Why: the consts above evaluate at module load. In `bun test` (single-process
 * across many files in src/commands/plugins/), any earlier file that imports
 * paths.ts (directly or transitively — almost everything does) freezes the
 * resolved path with whatever env was set at that import moment. Test files
 * that dynamic-import their target AFTER setting `MAW_CONFIG_DIR` or
 * `MAW_HOME` then see the wrong (frozen) path, not the env they just set.
 *
 * These getters re-read the env on every call, so test sandboxing works
 * regardless of import order. New call sites (and tests) should prefer the
 * getters; the consts stay for backward compat with the existing 30+ callers.
 */
export function getConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  return process.env.MAW_CONFIG_DIR || join(homedir(), ".config", "maw");
}
export function getFleetDir(): string { return join(getConfigDir(), "fleet"); }
export function getConfigFile(): string { return join(getConfigDir(), "maw.config.json"); }

// Ensure dirs exist on first import
mkdirSync(FLEET_DIR, { recursive: true });
