/**
 * Company/dept policy store — reads the policy markdown that `maw company sync`
 * drops under the company registry at
 *   <COMPANIES_DIR>/<company>/policy/{company.md,<dept>.md}
 *
 * Anchored on COMPANIES_DIR (the company-helpers live binding) so tests can
 * relocate the registry via `_setCompaniesDir`. Best-effort throughout: a
 * missing directory / file yields null, never an exception — policy injection
 * must never block or crash the agent.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";

/** Directory holding a company's policy markdown. */
export function policyDir(company: string): string {
  return join(COMPANIES_DIR, company, "policy");
}

function readOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf-8");
    return text.length ? text : null;
  } catch {
    return null;
  }
}

/** Company-wide policy (`<dir>/company.md`), or null when absent. */
export function readCompanyPolicy(company: string): string | null {
  return readOrNull(join(policyDir(company), "company.md"));
}

/** Department policy (`<dir>/<dept>.md`), or null when absent. */
export function readDeptPolicy(company: string, dept: string): string | null {
  return readOrNull(join(policyDir(company), `${dept}.md`));
}
