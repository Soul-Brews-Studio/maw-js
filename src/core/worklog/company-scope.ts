/**
 * Company scope resolution — the worklog boundary is the company (its members),
 * not the whole fleet. These map an oracle → its company / dept / lead.
 *
 * Only HITS are memoized per process; worklog hooks fire often and company
 * config rarely changes within a run. A miss is NEVER cached — a transient
 * config-load hiccup (e.g. at server start, before the registry is readable)
 * must not blind an oracle's activity permanently; the next call retries
 * (eq3-014). Never throws.
 */

import { listCompanies, loadCompany } from "../../vendor/mpr-plugins/company/company-helpers";

export interface OracleScope {
  company: string;
  /** Dept the oracle belongs to, or null for a company-level manager/PM. */
  dept: string | null;
  lead: string | null;
}

const scopeCache = new Map<string, OracleScope>();

function resolve(oracle: string): OracleScope | null {
  try {
    for (const c of listCompanies()) {
      for (const [dept, d] of Object.entries(c.departments)) {
        if (d.members.some(m => m.oracle === oracle)) {
          return { company: c.name, dept, lead: d.lead ?? null };
        }
      }
      // Company-level manager/PM (e.g. thawanban over pgw's dept leads) — a real
      // tier ABOVE the depts, deliberately NOT a dept member (adding them as one
      // would distort the roster into a subordinate). Maps to the company with
      // no dept (eq3-014).
      if (c.manager === oracle) {
        return { company: c.name, dept: null, lead: null };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Full scope (company/dept/lead) for an oracle. Hits memoized; misses retry. */
export function scopeOfOracle(oracle: string): OracleScope | null {
  const cached = scopeCache.get(oracle);
  if (cached) return cached;
  const s = resolve(oracle);
  if (s) scopeCache.set(oracle, s); // never memoize a miss — retry-on-miss
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
