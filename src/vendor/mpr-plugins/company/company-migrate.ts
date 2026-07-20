import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { listCompanies, loadCompany, resolveOracleRepoPath } from "./company-helpers";
import { MARKER_START, removeDeptBlockFromRepo } from "./company-claudemd";

/**
 * `maw company migrate` — sweep member repos and strip the stale static
 * "## Department" block (the #19 conditional-inject migration).
 *
 * Older versions wrote a static managed block into each member's CLAUDE.md on
 * assign, so dept identity was ALWAYS visible on wake. The new design injects
 * dept identity ONLY while attached (via the policy hook). This sweep removes
 * the leftover static block so "wake = 0 inject" is consistent across the fleet.
 *
 * Properties:
 *   - Idempotent — a repo with no block is skipped (skippedReason "no-block");
 *     re-running yields no further changes.
 *   - Path-scoped commit — commits ONLY CLAUDE.md, never other paths.
 *   - NEVER pushes — the oracle / Tony pushes. Commit + push stay separate.
 *   - Best-effort I/O — a missing repo, missing CLAUDE.md, or non-git repo
 *     never throws; the outcome simply reflects what happened.
 */

export interface RepoMigrateOutcome {
  oracle: string;
  repoPath: string | null; // null when unresolved (skipped)
  stripped: boolean; // block removed from CLAUDE.md
  committed: boolean; // CLAUDE.md committed (only when stripped && !dryRun && git available)
  skippedReason?: string; // "no-repo" | "no-block"
}

export interface MigrateResult {
  companies: string[]; // companies swept
  outcomes: RepoMigrateOutcome[];
  changed: number; // count stripped
}

export interface MigrateOpts {
  dryRun?: boolean;
  /** Default true; when true and stripped, commit CLAUDE.md path-scoped (NEVER push). */
  commit?: boolean;
}

/** Distinct oracle members of a company across all its departments (sorted). */
function companyOracles(company: string): string[] {
  const c = loadCompany(company);
  if (!c) return [];
  const seen = new Set<string>();
  for (const dept of Object.values(c.teams)) {
    for (const m of dept.members) seen.add(m.oracle);
  }
  return [...seen].sort();
}

/** True when <repoPath>/CLAUDE.md exists and still contains the managed marker. */
function repoHasBlock(repoPath: string): boolean {
  try {
    const file = join(repoPath, "CLAUDE.md");
    if (!existsSync(file)) return false;
    return readFileSync(file, "utf-8").includes(MARKER_START);
  } catch {
    return false;
  }
}

/**
 * Commit ONLY CLAUDE.md, path-scoped. Best-effort: a non-zero exit (nothing to
 * commit, not a git repo, …) returns false without throwing. NEVER pushes.
 */
function commitClaudeMd(repoPath: string): boolean {
  try {
    Bun.spawnSync(["git", "-C", repoPath, "add", "CLAUDE.md"]);
    const res = Bun.spawnSync([
      "git",
      "-C",
      repoPath,
      "commit",
      "-m",
      "chore: migrate dept block → conditional inject",
      "--",
      "CLAUDE.md",
    ]);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Sweep one or all companies and strip the stale static dept block from each
 * member's CLAUDE.md.
 *
 * @param company  A single company name, or undefined to sweep every company.
 * @param opts.dryRun  When true, only DETECT blocks (no write, no commit).
 * @param opts.commit  Default true; when stripped, commit CLAUDE.md path-scoped.
 */
export function migrateCompanyPolicy(
  company: string | undefined,
  opts: MigrateOpts = {},
): MigrateResult {
  const { dryRun = false, commit = true } = opts;
  const companies = company ? [company] : listCompanies().map((c) => c.name);

  const outcomes: RepoMigrateOutcome[] = [];

  for (const co of companies) {
    for (const oracle of companyOracles(co)) {
      const repoPath = resolveOracleRepoPath(oracle);

      if (!repoPath) {
        outcomes.push({
          oracle,
          repoPath: null,
          stripped: false,
          committed: false,
          skippedReason: "no-repo",
        });
        continue;
      }

      if (dryRun) {
        const stripped = repoHasBlock(repoPath);
        outcomes.push({
          oracle,
          repoPath,
          stripped,
          committed: false,
          skippedReason: stripped ? undefined : "no-block",
        });
        continue;
      }

      const stripped = removeDeptBlockFromRepo(repoPath);
      if (!stripped) {
        outcomes.push({
          oracle,
          repoPath,
          stripped: false,
          committed: false,
          skippedReason: "no-block",
        });
        continue;
      }

      const committed = commit ? commitClaudeMd(repoPath) : false;
      outcomes.push({ oracle, repoPath, stripped: true, committed });
    }
  }

  const changed = outcomes.filter((o) => o.stripped).length;
  return { companies, outcomes, changed };
}
