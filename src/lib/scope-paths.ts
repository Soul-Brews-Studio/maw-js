/**
 * scope-paths.ts — vendored scope-config-dir helpers (Phase 2 vendor, #918 follow-up).
 *
 * Mirrors the path helpers in `src/commands/plugins/scope/impl.ts` so that
 * `src/commands/shared/scope-acl.ts` (and any other src/core / src/api / src/lib
 * consumer) can resolve `<CONFIG_DIR>/scopes/` without reaching across the
 * plugin boundary into `src/commands/plugins/scope/`.
 *
 * After the follow-up "prune" PR removes the scope plugin's source, this
 * vendored copy is the canonical location for the path resolution logic.
 *
 * Path resolution mirrors `scope/impl.ts::activeConfigDir` exactly by
 * delegating to the shared XDG config resolver. Function (not const) so tests
 * overriding env per-test see fresh values each call.
 */
import { join } from "path";
import { mawConfigDir } from "../core/xdg";

function activeConfigDir(): string {
  return mawConfigDir();
}

export function scopesDir(): string {
  return join(activeConfigDir(), "scopes");
}

export function scopePath(name: string): string {
  return join(scopesDir(), `${name}.json`);
}
