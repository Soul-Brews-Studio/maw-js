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
import { hostExec } from "../transport/ssh";
import type { RepoDiscovery } from "./types";

function normalize(out: string): string[] {
  return out.split("\n").filter(Boolean).map((p) => p.replace(/\\/g, "/"));
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

export const GhqDiscovery: RepoDiscovery = {
  name: "ghq",

  async list(): Promise<string[]> {
    const out = await hostExec("ghq list --full-path").catch(() => "");
    return normalize(out);
  },

  listSync(): string[] {
    try {
      return normalize(execSync("ghq list --full-path", { encoding: "utf-8" }));
    } catch {
      return [];
    }
  },

  async findBySuffix(suffix: string): Promise<string | null> {
    const lower = literalize(suffix).toLowerCase();
    const all = (await this.list()).filter((p) => p.toLowerCase().endsWith(lower));
    if (all.length > 1) {
      // #1104 — multiple orgs have the same repo name; caller should use
      // an org-qualified suffix to disambiguate.
      console.error(`\x1b[33m⚠\x1b[0m ghq: ${all.length} repos match '${suffix}':`);
      for (const p of all) console.error(`\x1b[90m    • ${p}\x1b[0m`);
    }
    return all[0] ?? null;
  },

  findBySuffixSync(suffix: string): string | null {
    const lower = literalize(suffix).toLowerCase();
    return this.listSync().find((p) => p.toLowerCase().endsWith(lower)) ?? null;
  },
};

/** Internal — exposed for tests only. Normalizes raw ghq output. */
export const _normalize = normalize;
