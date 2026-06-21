import { checkBusyGuard } from "maw-js/sdk";
import { fuzzyMatch } from "../../../core/util/fuzzy";
import {
  loadCompany, listCompanies, departmentMembers,
  type Company, type DeptRole,
} from "./company-helpers";

/**
 * Company plugin — `attach` (operate layer, spec §5).
 *
 * `maw company attach <company-fuzzy> <dept-fuzzy> [--new]`
 *
 *   1. fuzzy-resolve the company name, then the department name (typos OK).
 *   2. find an IDLE (non-busy) member oracle in that department.
 *   3. smart-attach to it — reuse `maw attach` (connect if live, wake if asleep).
 *   4. all members busy → do NOT attach; report "<co>/<dept> full (N/N busy)".
 *   5. --new (explicit) → bud a NEW member into the dept via `maw bud`.
 *
 * The pure resolution / selection / reporting logic lives here and is unit
 * tested with an INJECTED busy-check (no process spawning in tests). The thin
 * `attachToDept` orchestrator owns the `Bun.spawn` calls and is not unit tested.
 */

/** Busy-check shape — matches `checkBusyGuard`'s result. Injected for tests. */
export type BusyCheck = (oracle: string) => Promise<{
  busy: boolean;
  status: string;
  oracle: string;
}>;

const defaultBusyCheck: BusyCheck = checkBusyGuard;

/**
 * Resolve `input` against `candidates`: exact match wins; else a prefix match
 * (e.g. "kob" → "kob-bank", "payme" → "payment") so short abbreviations land;
 * else nearest Levenshtein within `maxDistance`. Returns null on no match.
 */
function resolveName(input: string, candidates: string[], maxDistance = 4): string | null {
  if (!input) return null;
  if (candidates.includes(input)) return input;
  const lc = input.toLowerCase();
  // Prefix matches — accept the shortest (closest) candidate so abbreviations
  // like "kob" → "kob-bank" resolve even when edit distance is large.
  const prefixes = candidates
    .filter((c) => c.toLowerCase().startsWith(lc))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (prefixes.length > 0) return prefixes[0];
  const [best] = fuzzyMatch(input, candidates, 1, maxDistance);
  return best ?? null;
}

/** Fuzzy-resolve a company name from the registry. Exact match wins. */
export function fuzzyResolveCompany(input: string): string | null {
  return resolveName(input, listCompanies().map((c) => c.name));
}

/** Fuzzy-resolve a department key within a company. Exact match wins. */
export function fuzzyResolveDept(companyName: string, input: string): string | null {
  const c = loadCompany(companyName);
  if (!c) return null;
  return resolveName(input, Object.keys(c.departments));
}

export interface IdleMember {
  oracle: string;
  status: string;
}

/**
 * Find the first IDLE (non-busy) member of a department, in member order.
 *
 * An oracle is selectable when `busy === false`. Per `checkBusyGuard`, an oracle
 * the status API knows nothing about (asleep / no fleet entry) resolves to
 * `{ busy: false, status: "unknown" }` — so it IS selectable, and the
 * downstream `maw attach` will wake-then-attach it (spec §5 step 3). Only an
 * oracle actively reporting `busy` is skipped.
 *
 * Returns the chosen member (with its live status) or null when ALL are busy.
 */
export async function findIdleMember(
  company: string,
  dept: string,
  isBusy: BusyCheck = defaultBusyCheck,
): Promise<IdleMember | null> {
  const members = departmentMembers(company, dept);
  for (const m of members) {
    const guard = await isBusy(m.oracle);
    if (!guard.busy) return { oracle: m.oracle, status: guard.status };
  }
  return null;
}

export interface DeptBusyReport {
  total: number;
  busy: number;
  /** Non-busy and live (status ready/idle). */
  idle: number;
  /** Non-busy but not live (status unknown/offline) — wakeable. */
  sleeping: number;
  /** Oracle names that are sleeping (offered as wake candidates). */
  sleepingMembers: string[];
}

/** Classify every member by busy / idle / sleeping for the "all busy" message. */
export async function deptBusyReport(
  company: string,
  dept: string,
  isBusy: BusyCheck = defaultBusyCheck,
): Promise<DeptBusyReport> {
  const members = departmentMembers(company, dept);
  let busy = 0;
  let idle = 0;
  let sleeping = 0;
  const sleepingMembers: string[] = [];
  for (const m of members) {
    const guard = await isBusy(m.oracle);
    if (guard.busy) {
      busy++;
    } else if (guard.status === "unknown" || guard.status === "offline") {
      sleeping++;
      sleepingMembers.push(m.oracle);
    } else {
      idle++;
    }
  }
  return { total: members.length, busy, idle, sleeping, sleepingMembers };
}

/**
 * Conventional name for a NEW department member: `<company>-<dept>-<role>`.
 * On collision with an existing member, append `-2`, `-3`, … until free.
 */
export function nextNewMemberName(
  company: string,
  dept: string,
  role: DeptRole = "dev",
): string {
  const base = `${company}-${dept}-${role}`;
  const c = loadCompany(company);
  const taken = new Set((c?.departments[dept]?.members ?? []).map((m) => m.oracle));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ─── Orchestration (thin shell-out layer — not unit tested) ──────────────────

export interface AttachOptions {
  /** Explicit opt-in: bud a new member instead of attaching to an idle one. */
  isNew?: boolean;
  /** Department role for the budded member (default "dev"). */
  role?: DeptRole;
  /** Injected busy-check (defaults to checkBusyGuard). */
  isBusy?: BusyCheck;
}

export type AttachOutcome =
  | { kind: "no-company"; input: string }
  | { kind: "no-dept"; company: string; input: string }
  | { kind: "attached"; company: string; dept: string; oracle: string; status: string }
  | { kind: "budded"; company: string; dept: string; oracle: string }
  | { kind: "all-busy"; company: string; dept: string; report: DeptBusyReport };

/**
 * Resolve → find idle → smart-attach, or all-busy branch, or --new bud branch.
 * Spawns `maw attach` / `maw bud` as subprocesses (inherits stdio so the user
 * lands directly on the oracle's pane). Returns the outcome for the caller to
 * print. Spawn failures propagate as thrown errors.
 */
export async function attachToDept(
  companyInput: string,
  deptInput: string,
  opts: AttachOptions = {},
): Promise<AttachOutcome> {
  const isBusy = opts.isBusy ?? defaultBusyCheck;
  const role: DeptRole = opts.role ?? "dev";

  const company = fuzzyResolveCompany(companyInput);
  if (!company) return { kind: "no-company", input: companyInput };

  const dept = fuzzyResolveDept(company, deptInput);
  if (!dept) return { kind: "no-dept", company, input: deptInput };

  // --new is the ONLY path that spawns a new member (spec §5 — never auto-bud).
  if (opts.isNew) {
    const name = nextNewMemberName(company, dept, role);
    await spawnMaw([
      "bud", name,
      "--company", company,
      "--department", dept,
      "--role", role,
    ]);
    return { kind: "budded", company, dept, oracle: name };
  }

  const idle = await findIdleMember(company, dept, isBusy);
  if (!idle) {
    const report = await deptBusyReport(company, dept, isBusy);
    return { kind: "all-busy", company, dept, report };
  }

  // Smart-attach: connect if live, wake-then-attach if asleep. MAW_ATTACH_FOLLOWS=1
  // is the env attach/wake use to auto-follow into the pane after wake.
  await spawnMaw(["attach", idle.oracle], { MAW_ATTACH_FOLLOWS: "1" });
  return { kind: "attached", company, dept, oracle: idle.oracle, status: idle.status };
}

/** Run `maw <args>` as a subprocess, inheriting stdio (copied from attach/impl.ts). */
async function spawnMaw(args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(["maw", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`maw ${args.join(" ")} exited ${exitCode}`);
  }
}

// Re-export the Company type for callers that build on the outcome.
export type { Company };
