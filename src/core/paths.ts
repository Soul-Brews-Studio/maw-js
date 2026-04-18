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

// Ensure dirs exist on first import
mkdirSync(FLEET_DIR, { recursive: true });
