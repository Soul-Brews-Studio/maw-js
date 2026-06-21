import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { mawDataPath, loadFleetEntries, fleetLoadDirForWrite } from "maw-js/sdk";

/**
 * Company plugin — logical company > department > oracle layer.
 *
 * Storage (spec §2):
 *   - Registry:  ~/.maw/companies/<company>.json   (dept → members structure)
 *   - Per-oracle: fleet config (company / department / deptRole fields)
 *
 * The two stores are kept in sync on assign / remove. We deliberately reuse the
 * existing fleet config for the per-oracle fields rather than minting a new
 * store (spec §8 — reuse oracle config). The github `org` field is left
 * untouched; company/department/deptRole are a separate LOGICAL layer.
 */

export type DeptRole = "lead" | "dev" | "qa";

export interface DeptMember {
  oracle: string;
  role: DeptRole;
}

export interface Department {
  /** Optional lead oracle name (convenience pointer; also present in members). */
  lead?: string;
  /** KB (muninn) concept tag for department knowledge exchange (Phase 2). */
  kbTag: string;
  members: DeptMember[];
}

export interface Company {
  name: string;
  departments: Record<string, Department>;
}

// Exported for testing — override with _setCompaniesDir.
export let COMPANIES_DIR = mawDataPath("companies");

/** @internal — for tests only */
export function _setCompaniesDir(dir: string): void {
  COMPANIES_DIR = dir;
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/** Validate a company / department name: letter-led, alphanumeric + hyphens. */
export function assertValidName(kind: "company" | "department", name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid ${kind} name: "${name}" — must start with a letter and contain only letters, numbers, hyphens`,
    );
  }
}

export function companyPath(name: string): string {
  return join(COMPANIES_DIR, `${name}.json`);
}

export function companyExists(name: string): boolean {
  return existsSync(companyPath(name));
}

export function loadCompany(name: string): Company | null {
  const path = companyPath(name);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Company;
  // Normalize older/partial shapes — ensure members[] always present.
  for (const dept of Object.values(raw.departments ?? {})) {
    if (!Array.isArray(dept.members)) dept.members = [];
  }
  return raw;
}

export function saveCompany(company: Company): void {
  mkdirSync(COMPANIES_DIR, { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: registry under ~/.maw/companies/, see docs/security/file-system-race-stance.md
  writeFileSync(companyPath(company.name), JSON.stringify(company, null, 2) + "\n");
}

export function listCompanies(): Company[] {
  if (!existsSync(COMPANIES_DIR)) return [];
  return readdirSync(COMPANIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .map((n) => loadCompany(n))
    .filter((c): c is Company => c !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createCompany(name: string): Company {
  assertValidName("company", name);
  if (companyExists(name)) {
    throw new Error(`company '${name}' already exists`);
  }
  const company: Company = { name, departments: {} };
  saveCompany(company);
  return company;
}

export function deleteCompany(name: string): void {
  const path = companyPath(name);
  if (!existsSync(path)) throw new Error(`company '${name}' not found`);
  rmSync(path);
}

export function kbTagFor(company: string, dept: string): string {
  return `dept:${company}:${dept}`;
}

export function addDepartment(company: string, dept: string, opts: { lead?: string } = {}): Company {
  assertValidName("department", dept);
  const c = loadCompany(company);
  if (!c) throw new Error(`company '${company}' not found — run: maw company create ${company}`);
  if (c.departments[dept]) throw new Error(`department '${dept}' already exists in '${company}'`);
  c.departments[dept] = {
    lead: opts.lead,
    kbTag: kbTagFor(company, dept),
    members: opts.lead ? [{ oracle: opts.lead, role: "lead" }] : [],
  };
  saveCompany(c);
  if (opts.lead) syncOracleAssignment(opts.lead, { company, department: dept, deptRole: "lead" });
  return c;
}

export function removeDepartment(company: string, dept: string): Company {
  const c = loadCompany(company);
  if (!c) throw new Error(`company '${company}' not found`);
  const d = c.departments[dept];
  if (!d) throw new Error(`department '${dept}' not found in '${company}'`);
  // Clear per-oracle assignment for every member before dropping the dept.
  for (const m of d.members) clearOracleAssignment(m.oracle, { company, department: dept });
  delete c.departments[dept];
  saveCompany(c);
  return c;
}

export interface NamingCollision {
  /** True when an oracle of this name is already a member of the department. */
  collision: boolean;
  /** Suggested structured name: <company>-<dept>-<role>. */
  suggestion: string;
}

/**
 * Naming guard (spec §3): detect a name collision within a department and
 * suggest the structured convention `<company>-<dept>-<role>`.
 *
 * This is a WARN-level signal — callers print the warning but do NOT block.
 */
export function checkNamingCollision(
  company: string,
  dept: string,
  oracle: string,
  role: DeptRole = "dev",
): NamingCollision {
  const c = loadCompany(company);
  const members = c?.departments[dept]?.members ?? [];
  const collision = members.some((m) => m.oracle === oracle);
  return { collision, suggestion: `${company}-${dept}-${role}` };
}

export interface AssignResult {
  company: Company;
  /** Naming guard result, surfaced so the caller can warn. */
  naming: NamingCollision;
  /** True when this oracle was already in the dept (role may have changed). */
  alreadyMember: boolean;
}

export function assignMember(
  company: string,
  dept: string,
  oracle: string,
  role: DeptRole = "dev",
): AssignResult {
  const c = loadCompany(company);
  if (!c) throw new Error(`company '${company}' not found — run: maw company create ${company}`);
  const d = c.departments[dept];
  if (!d) throw new Error(`department '${dept}' not found in '${company}' — run: maw company add-dept ${company} ${dept}`);

  const naming = checkNamingCollision(company, dept, oracle, role);

  const existing = d.members.find((m) => m.oracle === oracle);
  const alreadyMember = !!existing;
  if (existing) {
    existing.role = role;
  } else {
    d.members.push({ oracle, role });
  }
  if (role === "lead") d.lead = oracle;
  saveCompany(c);
  syncOracleAssignment(oracle, { company, department: dept, deptRole: role });
  return { company: c, naming, alreadyMember };
}

export function removeMember(company: string, dept: string, oracle: string): Company {
  const c = loadCompany(company);
  if (!c) throw new Error(`company '${company}' not found`);
  const d = c.departments[dept];
  if (!d) throw new Error(`department '${dept}' not found in '${company}'`);
  const idx = d.members.findIndex((m) => m.oracle === oracle);
  if (idx === -1) throw new Error(`'${oracle}' is not a member of ${company}/${dept}`);
  d.members.splice(idx, 1);
  if (d.lead === oracle) d.lead = undefined;
  saveCompany(c);
  clearOracleAssignment(oracle, { company, department: dept });
  return c;
}

export function departmentMembers(company: string, dept: string): DeptMember[] {
  const c = loadCompany(company);
  if (!c) throw new Error(`company '${company}' not found`);
  const d = c.departments[dept];
  if (!d) throw new Error(`department '${dept}' not found in '${company}'`);
  return d.members;
}

// ─── Per-oracle fleet config sync ────────────────────────────────────────────

interface OracleAssignment {
  company: string;
  department: string;
  deptRole?: DeptRole;
}

/** Resolve the writable fleet config file for an oracle by stem name, if any. */
function fleetFileForOracle(oracle: string): string | null {
  const entries = loadFleetEntries();
  const entry = entries.find((e) => e.session.name.replace(/^\d+-/, "") === oracle);
  if (!entry) return null;
  return entry.path ?? join(fleetLoadDirForWrite(), entry.file);
}

/**
 * Write company/department/deptRole onto the oracle's fleet config WITHOUT
 * disturbing existing fields. No-op (returns false) when the oracle has no
 * fleet config on disk — the registry remains the source of truth either way.
 */
export function syncOracleAssignment(oracle: string, a: OracleAssignment): boolean {
  const file = fleetFileForOracle(oracle);
  if (!file) return false;
  const cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  cfg.company = a.company;
  cfg.department = a.department;
  if (a.deptRole) cfg.deptRole = a.deptRole;
  else delete cfg.deptRole;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

/** Clear company/department/deptRole when an oracle leaves a department. */
export function clearOracleAssignment(
  oracle: string,
  scope: { company: string; department: string },
): boolean {
  const file = fleetFileForOracle(oracle);
  if (!file) return false;
  const cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  // Only clear when the fleet config still points at THIS company/department
  // (avoid clobbering a re-assignment elsewhere).
  if (cfg.company === scope.company && cfg.department === scope.department) {
    delete cfg.company;
    delete cfg.department;
    delete cfg.deptRole;
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    return true;
  }
  return false;
}

/** Read an oracle's logical company/department/deptRole from its fleet config. */
export function readOracleAssignment(oracle: string): {
  company?: string;
  department?: string;
  deptRole?: string;
} {
  const file = fleetFileForOracle(oracle);
  if (!file) return {};
  try {
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    return {
      company: cfg.company as string | undefined,
      department: cfg.department as string | undefined,
      deptRole: cfg.deptRole as string | undefined,
    };
  } catch {
    return {};
  }
}
