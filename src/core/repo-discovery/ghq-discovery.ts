/**
 * GhqDiscovery — RepoDiscovery backed by `ghq list --full-path`.
 *
 * ghq supports 9 VCSes (git/svn/hg/darcs/pijul/cvs/fossil/bzr/git-svn),
 * so this adapter inherits all of them for free. Historically this logic
 * lived flat in src/core/ghq.ts; now it's behind the RepoDiscovery seam
 * so future adapters (fs-scan, jj, etc.) can slot in at ../index.
 *
 * Normalization rationale: `ghq list --full-path` returns backslash paths
 * on Windows (`C:\Users\...`) but every maw-js call site uses forward-slash
 * patterns. PR #379 added `| tr '\\' '/'` at 13 call sites; this is the
 * choke point that keeps that fix from being re-forgotten.
 */

import { execSync } from "child_process";
import { resolve } from "path";
import { hostExec } from "../transport/ssh";
import type { RepoDetectResult, RepoDiscovery } from "./types";

function normalize(out: string): string[] {
  return out.split("\n").filter(Boolean).map((p) => p.replace(/\\/g, "/"));
}

/**
 * #2573 — pure path helper, shared with {@link GhqDiscovery.detectFromCwd}.
 * Strips a trailing `-oracle` (case-insensitive) and preserves the original
 * case of the stem. Returns `null` when the segment is not an oracle name.
 */
export function stripOracleRepoSuffix(name: string): string | null {
  return name.toLowerCase().endsWith("-oracle") ? name.slice(0, -"-oracle".length) : null;
}

/**
 * #2573 — single source of truth for CWD → `{ oracle, worktree }` derivation.
 * Path-string analysis only; no ghq exec, no filesystem I/O. See the
 * `detectFromCwd` contract in {@link RepoDiscovery} for the recognized layouts.
 * Exported so other backends (and the wake-cwd compat shim) can reuse it
 * without going through the singleton.
 */
export function detectFromCwdPath(cwd: string | undefined): RepoDetectResult | null {
  const parts = cwd ? resolve(cwd).split(/[\\/]+/).filter(Boolean) : [];
  if (parts.length === 0) return null;

  const agentsIdx = parts.lastIndexOf("agents");
  if (agentsIdx > 0 && parts[agentsIdx + 1]) {
    const oracle = stripOracleRepoSuffix(parts[agentsIdx - 1] ?? "") ?? undefined;
    return { oracle, worktree: parts[agentsIdx + 1] };
  }

  for (const part of parts.slice().reverse()) {
    const worktreeMarker = part.indexOf(".wt-");
    if (worktreeMarker > 0) {
      const oracle = stripOracleRepoSuffix(part.slice(0, worktreeMarker)) ?? undefined;
      const worktree = part.slice(worktreeMarker + ".wt-".length) || undefined;
      return { oracle, worktree };
    }
    const oracle = stripOracleRepoSuffix(part);
    if (oracle) return { oracle };
  }
  return null;
}

/**
 * Strip trailing `$` if present. Backward compat for callers migrated from
 * the old `grep '/foo$'` shell pattern — `$` is meaningless in literal
 * endsWith but harmless to strip. Without this guard, `findBySuffix("/oracle$")`
 * would always return null. Caught by team-agents debate 2026-04-16.
 */
function literalize(suffix: string): string {
  return suffix.endsWith("$") ? suffix.slice(0, -1) : suffix;
}

/**
 * #2577 — pick the best repo path among the ghq suffix-matches.
 *
 * A misconfigured ghq root (one that already ends in `.../github.com`) makes
 * ghq clone into a DOUBLED `…/github.com/github.com/<org>/<repo>` path. `ghq
 * list` then surfaces BOTH that and the correct `…/github.com/<org>/<repo>`,
 * and since both `endsWith` the queried suffix the old first-match returned
 * whichever ghq happened to list first — which broke `maw wake neo`. Prefer a
 * canonical (non-doubled) path; fall back to a doubled one only when it is the
 * sole match, so a genuinely doubled-only checkout still resolves.
 *
 * Exported for tests.
 */
export function selectRepoMatch(paths: string[], suffix: string): string | null {
  const lower = literalize(suffix).toLowerCase();
  const matches = paths.filter((p) => p.toLowerCase().endsWith(lower));
  if (matches.length === 0) return null;
  const canonical = matches.find((p) => !p.toLowerCase().includes("/github.com/github.com/"));
  return canonical ?? matches[0]!;
}

export const GhqDiscovery: RepoDiscovery = {
  name: "ghq",

  async list(): Promise<string[]> {
    const out = await hostExec("ghq list --full-path").catch(() => "");
    return normalize(out);
  },

  listSync(): string[] {
    try {
      return normalize(execSync("ghq list --full-path", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch {
      return [];
    }
  },

  async findBySuffix(suffix: string): Promise<string | null> {
    return selectRepoMatch(await this.list(), suffix);
  },

  findBySuffixSync(suffix: string): string | null {
    return selectRepoMatch(this.listSync(), suffix);
  },

  detectFromCwd(cwd?: string): RepoDetectResult | null {
    return detectFromCwdPath(cwd ?? process.cwd());
  },
};

/** Internal — exposed for tests only. Normalizes raw ghq output. */
export const _normalize = normalize;
