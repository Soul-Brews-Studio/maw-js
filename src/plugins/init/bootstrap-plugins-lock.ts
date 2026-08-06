import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { LOCK_SCHEMA, lockPath, writeLock } from "./internal/plugin-lock";

export interface BootstrapPluginsLockResult {
  created: boolean;
  path: string;
}

/**
 * First-run bootstrap for ~/.maw/plugins.lock (#680 ask 4).
 *
 * If the lockfile is absent, create it with an empty-but-valid shape so every
 * subsequent `maw plugin install` has a truth file to write into. If present,
 * leave it alone — never overwrite, never merge.
 */
export function bootstrapPluginsLock(): BootstrapPluginsLockResult {
  const path = lockPath();
  if (existsSync(path)) return { created: false, path };

  mkdirSync(dirname(path), { recursive: true });
  writeLock({ schema: LOCK_SCHEMA, updated: new Date().toISOString(), plugins: {} });
  return { created: true, path };
}
