/**
 * wake-cwd.ts — directory → oracle/worktree derivation for wake.
 *
 * #2573 — the path-detection logic now lives behind the RepoDiscovery seam
 * (`getRepos().detectFromCwd(cwd)`). This module is a thin compatibility shim
 * that preserves the legacy entry points used by `wake-cmd.ts`, the wake
 * barrel re-export, and the `oracle-workon` plugin. The pure path helpers
 * themselves live in `core/repo-discovery/ghq-discovery.ts` and are imported
 * here so wake-cwd stays deps-free (no sdk/config cascade) for unit tests.
 */

import { resolve } from "path";
import { getRepos } from "../../core/repo-discovery";
import { stripOracleRepoSuffix as _stripOracleRepoSuffix } from "../../core/repo-discovery/ghq-discovery";

export function stripOracleRepoSuffix(name: string): string | null {
  return _stripOracleRepoSuffix(name);
}

/**
 * Extract `{ oracle, worktree }` from a directory path. Thin wrapper over
 * {@link RepoDiscovery.detectFromCwd}; returns `{}` (not `null`) on no match
 * because every existing caller already spreads/destructures the result.
 *
 * Legacy behavior preserved: an empty/undefined `cwd` returns `{}` — callers
 * that want the process.cwd() default pass it explicitly.
 */
export function bringCwdMetadata(cwd: string | undefined): { oracle?: string; worktree?: string } {
  if (!cwd) return {};
  return getRepos().detectFromCwd(cwd) ?? {};
}

/**
 * #2569 — derive an oracle name from a directory for zero-arg `maw wake`.
 *
 * Delegates the path detection to {@link RepoDiscovery.detectFromCwd}, then
 * falls back to the path's last segment (stripping a trailing `-oracle` if
 * present) so the normal `resolveOracle` fuzzy chain can take it from there.
 * Returns undefined only for empty/root paths.
 */
export function deriveOracleFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const meta = getRepos().detectFromCwd(cwd);
  if (meta?.oracle) return meta.oracle;
  const parts = resolve(cwd).split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1];
  if (!base) return undefined;
  return stripOracleRepoSuffix(base) ?? base;
}
