import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { COMPANIES_DIR, loadCompany, resolveOracleRepoPath } from "./company-helpers";

/**
 * Company policy sync — `maw company sync <co> --from <oracle-or-path>`.
 *
 * Policy SOURCE is tracked in a manager repo under `policies/`
 * (e.g. thawanban-oracle: `policies/company.md`, `policies/<dept>.md`).
 * This module copies a SNAPSHOT of those files down into the local maw data
 * dir at `<COMPANIES_DIR>/<co>/policy/{company.md,<dept>.md}` so the
 * policy-inject hook can read it locally — fast, no repo resolution at hook
 * time.
 *
 * Pure file copy: no process spawning, fully unit-testable. Output is anchored
 * on COMPANIES_DIR so tests can redirect it via `_setCompaniesDir`.
 *
 * Failure model: only two HARD failures yield `ok:false` — an unknown company,
 * or a missing/unresolvable source dir. A missing individual policy file is a
 * soft signal recorded in `missing` (warn, not error); `ok` stays true.
 */

export interface PolicySyncResult {
  company: string;
  sourceDir: string; // resolved <repo>/policies
  written: string[]; // e.g. ["company.md", "core.md"]
  missing: string[]; // expected-but-absent source files (warn, not error), e.g. ["qa.md"]
  ok: boolean; // false if sourceDir didn't exist or company unknown
  error?: string;
}

/**
 * Resolve the policy source directory from `--from`.
 *
 * `from` may be either an existing directory path (used as the repo root) or an
 * oracle name (resolved to its repo dir via `resolveOracleRepoPath`). Returns
 * `<root>/policies`, or null when the root cannot be resolved.
 */
export function resolvePolicySource(from: string): string | null {
  let root: string | null = null;
  if (existsSync(from) && statSync(from).isDirectory()) {
    root = from;
  } else {
    root = resolveOracleRepoPath(from);
  }
  if (!root) return null;
  return join(root, "policies");
}

/** Copy `<name>` from sourceDir to destDir if present; returns true when copied. */
function copyIfPresent(sourceDir: string, destDir: string, name: string): boolean {
  const src = join(sourceDir, name);
  if (!existsSync(src) || !statSync(src).isFile()) return false;
  writeFileSync(join(destDir, name), readFileSync(src, "utf-8"));
  return true;
}

/**
 * Pull a policy snapshot for `company` from the source resolved from `from`.
 * See module header for the failure model.
 */
export function syncCompanyPolicy(company: string, from: string): PolicySyncResult {
  const result: PolicySyncResult = {
    company,
    sourceDir: "",
    written: [],
    missing: [],
    ok: false,
  };

  const c = loadCompany(company);
  if (!c) {
    result.error = `company '${company}' not found`;
    return result;
  }

  const sourceDir = resolvePolicySource(from);
  if (!sourceDir || !existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    result.error = `policy source not found: ${from}`;
    return result;
  }
  result.sourceDir = sourceDir;

  const destDir = join(COMPANIES_DIR, company, "policy");
  mkdirSync(destDir, { recursive: true });

  // Company-wide policy.
  if (copyIfPresent(sourceDir, destDir, "company.md")) result.written.push("company.md");
  else result.missing.push("company.md");

  // Per-department policy.
  for (const dept of Object.keys(c.departments)) {
    const file = `${dept}.md`;
    if (copyIfPresent(sourceDir, destDir, file)) result.written.push(file);
    else result.missing.push(file);
  }

  result.ok = true;
  return result;
}
