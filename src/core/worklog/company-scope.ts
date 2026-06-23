/**
 * Company scope resolution — the worklog boundary is the company (its members),
 * not the whole fleet. These map an oracle → its company / dept / lead.
 *
 * Results are memoized per process; worklog hooks fire often and company config
 * rarely changes within a run. Never throws.
 */

import { listCompanies, loadCompany } from "../../vendor/mpr-plugins/company/company-helpers";

export interface OracleScope {
  company: string;
  dept: string;
  lead: string | null;
}

const scopeCache = new Map<string, OracleScope | null>();

function resolve(oracle: string): OracleScope | null {
  try {
    for (const c of listCompanies()) {
      for (const [dept, d] of Object.entries(c.departments)) {
        if (d.members.some(m => m.oracle === oracle)) {
          return { company: c.name, dept, lead: d.lead ?? null };
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Full scope (company/dept/lead) for an oracle, memoized. */
export function scopeOfOracle(oracle: string): OracleScope | null {
  if (scopeCache.has(oracle)) return scopeCache.get(oracle)!;
  const s = resolve(oracle);
  scopeCache.set(oracle, s);
  return s;
}

/** Company an oracle belongs to (or null). */
export function companyOfOracle(oracle: string): string | null {
  return scopeOfOracle(oracle)?.company ?? null;
}

/** All oracle names that are members of a company (any dept). */
export function companyOracles(company: string): string[] {
  const c = loadCompany(company);
  if (!c) return [];
  const set = new Set<string>();
  for (const d of Object.values(c.departments)) {
    for (const m of d.members) set.add(m.oracle);
  }
  return [...set];
}

/** @internal — tests */
export function _clearScopeCache(): void {
  scopeCache.clear();
}
