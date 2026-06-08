/**
 * wake-cwd.ts — directory → oracle/worktree derivation for wake.
 *
 * Pure path-string helpers, intentionally free of sdk/config imports so they
 * can be unit-tested with zero mocks (no cfgLimit/cfgTimeout cascade). Consumed
 * by wake-cmd.ts for the `bring` window metadata and for #2569 zero-arg wake.
 */

import { resolve } from "path";

export function stripOracleRepoSuffix(name: string): string | null {
  return name.toLowerCase().endsWith("-oracle") ? name.slice(0, -"-oracle".length) : null;
}

/**
 * Extract `{ oracle, worktree }` from a directory path. Recognizes:
 *   - nested worktree layout `…/<oracle>-oracle/agents/<worktree>`,
 *   - legacy worktree dirs `…/<oracle>-oracle.wt-<worktree>`,
 *   - a plain `<oracle>-oracle` segment anywhere up the path.
 * Returns `{}` when no `-oracle` segment is present (e.g. a source repo dir).
 */
export function bringCwdMetadata(cwd: string | undefined): { oracle?: string; worktree?: string } {
  const parts = cwd ? resolve(cwd).split(/[\\/]+/).filter(Boolean) : [];
  const agentsIdx = parts.lastIndexOf("agents");
  if (agentsIdx > 0 && parts[agentsIdx + 1]) {
    return {
      oracle: stripOracleRepoSuffix(parts[agentsIdx - 1] ?? "") ?? undefined,
      worktree: parts[agentsIdx + 1],
    };
  }

  for (const part of parts.slice().reverse()) {
    const worktreeMarker = part.indexOf(".wt-");
    if (worktreeMarker > 0) {
      const oracle = stripOracleRepoSuffix(part.slice(0, worktreeMarker)) ?? undefined;
      return { oracle, worktree: part.slice(worktreeMarker + ".wt-".length) || undefined };
    }
    const oracle = stripOracleRepoSuffix(part);
    if (oracle) return { oracle };
  }
  return {};
}

/**
 * #2569 — derive an oracle name from a directory for zero-arg `maw wake`.
 *
 * Reuses {@link bringCwdMetadata} (handles `<oracle>-oracle` dirs, `agents/`
 * worktrees, and `.wt-` worktrees). When that finds nothing — e.g. the maw-js
 * source repo, whose dir is `maw-js` with no `-oracle` suffix — it falls back
 * to the last path segment (stripping a trailing `-oracle` if present) so the
 * normal `resolveOracle` fuzzy chain can take it from there. Returns undefined
 * only for empty/root paths.
 *
 * Note: the fallback uses the path's final segment, so it assumes the cwd is a
 * repo root (or any `-oracle` path, which the metadata pass already handles).
 */
export function deriveOracleFromCwd(cwd: string | undefined): string | undefined {
  const meta = bringCwdMetadata(cwd);
  if (meta.oracle) return meta.oracle;
  const parts = cwd ? resolve(cwd).split(/[\\/]+/).filter(Boolean) : [];
  const base = parts[parts.length - 1];
  if (!base) return undefined;
  return stripOracleRepoSuffix(base) ?? base;
}
