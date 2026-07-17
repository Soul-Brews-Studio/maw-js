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

/** Company an oracle belongs to (or null). Soft, deterministic: the alphabetically
 *  FIRST company it belongs to (listCompanies is name-sorted), so this and the
 *  barrel-free twin companyOfOracleLight always agree (kobo-216). For an idempotency-
 *  or board-minting decision use companyOfOracleStrict, which refuses to guess. */
export function companyOfOracle(oracle: string): string | null {
  return scopeOfOracle(oracle)?.company ?? null;
}

/** EVERY company an oracle belongs to (manager or any dept member), in the single
 *  deterministic order both resolvers share — name-sorted, via listCompanies (kobo-216).
 *  Empty when the registry is unreadable or the oracle is unknown. Never throws. */
export function companiesOfOracle(oracle: string): string[] {
  const out: string[] = [];
  try {
    for (const c of listCompanies()) { // name-sorted — the canonical order
      const member = Object.values(c.departments).some(d => d.members.some(m => m.oracle === oracle));
      if (member || c.manager === oracle) out.push(c.name);
    }
  } catch {
    /* registry unreadable → empty (mirrors resolve()'s never-throw contract) */
  }
  return out;
}

/**
 * Strict resolver for the actor / idempotency paths (kobo-216, Card B of kobo-166,
 * Tony option-a). Unlike companyOfOracle it REFUSES to silently first-match when an
 * oracle spans 2+ companies — that arbitrary pick is what let a `[request:]` dispatch
 * scope its dedup lookup to the wrong company and mint a duplicate card.
 *
 *   - `explicit` (a --company flag) → trust it, no ambiguity possible
 *   - 0 companies → null (the caller falls back to config, unchanged behavior)
 *   - exactly 1 → that company (single-company path is byte-for-byte unchanged)
 *   - 2+ and no explicit → THROW loud so the caller must disambiguate
 *
 * 🔒 SACRED: this only gates BEFORE any idempotency/dedup key is derived — it never
 * touches the key, the hash, or the dedup logic (Golden Rule: hash is untouchable).
 */
export function companyOfOracleStrict(oracle: string, explicit?: string | null): string | null {
  if (explicit) return explicit;
  const companies = companiesOfOracle(oracle);
  if (companies.length === 0) return null;
  if (companies.length === 1) return companies[0];
  throw new Error(`ambiguous: ${oracle} belongs to [${companies.join(", ")}] — specify --company`);
}

/** All oracle names that are members of a company (any dept), including the manager. */
export function companyOracles(company: string): string[] {
  const c = loadCompany(company);
  if (!c) return [];
  const set = new Set<string>();
  // kobo-290: the company manager (lead) is an oracle too — include it alongside
  // dept members so setup-hooks/hooks-status don't skip the lead pane (without this
  // the lead gets neither toilet-away nor seat-back → board-lie both directions).
  // Set dedups if the manager also appears in a dept. Mirrors companyRoster().
  if (c.manager) set.add(c.manager);
  for (const d of Object.values(c.departments)) {
    for (const m of d.members) set.add(m.oracle);
  }
  return [...set];
}

// kobo-341: cross-company dispatch is always allowed to reach a human/placeholder —
// these are NOT company oracles but are legit dispatch targets (Board Truth rule 14:
// assignee=human; `any` = the unassigned wildcard).
const CROSS_COMPANY_DISPATCH_OK = new Set(["human", "tony", "any"]);

/**
 * kobo-341: guard cross-company task dispatch. A card's assignee/reviewer/handoff must
 * be someone the company can actually reach — a member of THAT company (any dept, or the
 * company manager/lead who sits above the depts, e.g. eq3 over kobo), or a human. A
 * target fully OUTSIDE the company (e.g. a pgw card assigned to `patchwork`) is refused:
 * the notify path pings the target's real fleet pane cross-company (kobo-334), which is
 * cross-company pollution + a mild info-leak. Returns an error string to refuse, or null
 * to allow. The allowlist is the company MEMBERS (companyOracles = manager + dept members)
 * — deliberately NOT dept-only, which would break legit lead/human assigns (rule 14).
 */
export function companyScopeViolation(company: string, target: string | null | undefined): string | null {
  const t = (target ?? "").trim();
  if (!t || CROSS_COMPANY_DISPATCH_OK.has(t.toLowerCase())) return null;
  const members = companyOracles(company);
  // An unregistered company (no registry entry → no members) can't be membership-scoped —
  // allow rather than refuse every target (the guard scopes REGISTERED companies; the
  // kobo-334 vector is a real registered company reaching a non-member).
  if (members.length === 0 || members.includes(t)) return null;
  return `refuse: "${t}" is not in company "${company}" — cross-company dispatch is blocked (kobo-341). Assign/review to a company member (a dept oracle or the manager) or a human.`;
}

/** One roster entry — an oracle's place in the company org (kobo-50 presence). */
export interface RosterMember {
  oracle: string;
  dept: string | null; // null = a company-level manager/PM (a tier above the depts)
  role: string; // dept role ("lead"|"dev"|"qa") or "manager" for the company PM
}

/**
 * The AUTHORITATIVE company roster (kobo-50, item 3) — every oracle in the
 * registry with its dept + role, so the web Presence tab can show the full
 * membership (incl. oracles with no recent worklog activity, the c5 gap). Reads
 * the company registry (loadCompany), NOT `maw ls` — `maw ls` is fleet/tmux-wide
 * live sessions, not company membership. First dept a name appears in wins (a
 * name shouldn't be in two, but be deterministic if it is). Never throws.
 */
export function companyRoster(company: string): RosterMember[] {
  const c = loadCompany(company);
  if (!c) return [];
  const out: RosterMember[] = [];
  const seen = new Set<string>();
  if (c.manager && !seen.has(c.manager)) {
    seen.add(c.manager);
    out.push({ oracle: c.manager, dept: null, role: "manager" });
  }
  for (const [dept, d] of Object.entries(c.departments)) {
    for (const m of d.members) {
      if (seen.has(m.oracle)) continue;
      seen.add(m.oracle);
      out.push({ oracle: m.oracle, dept, role: m.role });
    }
  }
  return out;
}

/** @internal — tests */
export function _clearScopeCache(): void {
  scopeCache.clear();
}
