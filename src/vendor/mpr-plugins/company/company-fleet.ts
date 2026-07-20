/**
 * `maw company up/down <company>` — fleet wake+teardown for an entire company
 * (kobo-362). Design-first, eq3-blessed spec:
 *
 *   - manager (company.manager, if set) → head-cell: 👤 lead + 🎼 conductor + 🔎 reviewer.
 *   - dept lead + dept members → crew-front: 🧭 front + 🎼 conductor + ⚒ worker (≥1) + 🔎 reviewer.
 *   - no manager set → NO head-cell; every member is crew-front. Reported loudly
 *     (never a silent core-lead fallback — a dept lead is not a company head).
 *
 * v1 SCOPE (eq3 ruling, 2-tier): a manager whose head-cell is incomplete is
 * REPORT-ONLY (loud) — no head-spawn verb exists yet (kobo-364, a separate
 * follow-up: porting /head to a binary verb the way kobo-358 ported /crew).
 * For crew-front members, `up` is 2-tier:
 *   (1) session-tier — no session at all → `cmdWake(oracle, {})` cold-starts
 *       one (empirically verified: `maw wake <asleep-registered-oracle>`
 *       creates a brand-new session from scratch — this is IN-scope core
 *       value, reusing the existing verb, not scope-creep). `cmdWake` itself
 *       throwing (repo/home unresolvable — never set up) → LOUD report, no
 *       retry/guess.
 *   (2) crew-tier — once a session exists (already did, or wake just made
 *       one), incomplete/missing crew panes → repair via injected
 *       `maw company crew spawn <co>` (crewSpawn's own teardown+rebuild is
 *       reused as-is, triggered remotely via tmux send-keys — crewSpawn reads
 *       its OWN pane's TMUX_PANE, so it must run FROM inside that pane, not
 *       be called in-process against a different session).
 *
 * Member→session resolution reuses `findWindow`/`listSessions` (the exact
 * `maw hey <oracle>` machinery, plugin-safe via maw-js/sdk) rather than
 * inventing a new lookup — a company member's crew/head cell lives in that
 * oracle's home session (`NN-<oracle>` convention); crewSpawn adds
 * windows/panes to it, it never creates a new session itself (only `cmdWake`
 * does, at the session tier).
 *
 * `down` reuses kobo-358's `teardownCrewWindows` AS-IS for the crew-tier sweep
 * (it already protects the front/lead pane — a session-scoped protectPaneId
 * resolve, not a rewrite) then explicitly kills that front/lead pane too,
 * UNLESS it's the GLOBAL invoker's own pane (the one universal exception —
 * `down` must never kill the pane that ran the command). Refuses on a busy
 * member by default (checkBusyGuard) — `--force` to hard-kill anyway.
 */
import { hostExec, listSessions, findWindow, checkBusyGuard, cmdWake, type Session } from "maw-js/sdk";
import { loadCompany, type Company } from "./company-helpers";
import { teardownCrewWindows } from "../crew/teardown";

interface RosterMember {
  oracle: string;
  isManager: boolean;
}

/** manager (if set) + every unique dept/team member — dedup by oracle name. */
function companyRoster(co: Company): RosterMember[] {
  const seen = new Set<string>();
  const out: RosterMember[] = [];
  if (co.manager) {
    seen.add(co.manager);
    out.push({ oracle: co.manager, isManager: true });
  }
  for (const team of Object.values(co.teams)) {
    for (const m of team.members) {
      if (seen.has(m.oracle)) continue;
      seen.add(m.oracle);
      out.push({ oracle: m.oracle, isManager: false });
    }
  }
  return out;
}

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface PaneRow {
  paneId: string;
  role: string;
}

async function listSessionPanes(sessionName: string, hostExecFn: typeof hostExec): Promise<PaneRow[]> {
  let raw: string;
  try {
    raw = await hostExecFn(`tmux list-panes -t ${shellArg(sessionName)} -F '#{pane_id}|||#{@role}'`);
  } catch {
    return []; // session vanished mid-check — treat as no panes (report-only, never throw)
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    const [paneId = "", role = ""] = line.split("|||");
    return { paneId, role };
  });
}

function hasRole(panes: PaneRow[], prefix: string): boolean {
  return panes.some((p) => p.role.startsWith(prefix));
}

function findRolePane(panes: PaneRow[], prefix: string): string | undefined {
  return panes.find((p) => p.role.startsWith(prefix))?.paneId;
}

/** session:window (from findWindow) → the session-name part (before the first ':'). */
function sessionNameOf(resolved: string): string {
  const i = resolved.indexOf(":");
  return i === -1 ? resolved : resolved.slice(0, i);
}

export interface CompanyFleetDeps {
  hostExecFn?: typeof hostExec;
  listSessionsFn?: typeof listSessions;
  findWindowFn?: typeof findWindow;
  checkBusyGuardFn?: typeof checkBusyGuard;
  teardownCrewWindowsFn?: typeof teardownCrewWindows;
  cmdWakeFn?: typeof cmdWake;
}

/** Resolve an oracle's home session via the shared findWindow machinery — null on no-match or ambiguity (fail-safe, never guess). */
function resolveMemberSession(oracle: string, sessions: Session[], findWindowFn: typeof findWindow): string | null {
  try {
    return findWindowFn(sessions, oracle);
  } catch {
    return null; // ambiguous match → report-only, don't guess which session
  }
}

export async function companyUp(
  company: string | undefined,
  emit: (line: string) => void,
  deps: CompanyFleetDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!company) return { ok: false, error: "usage: maw company up <company>" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const hostExecFn = deps.hostExecFn ?? hostExec;
  const listSessionsFn = deps.listSessionsFn ?? listSessions;
  const findWindowFn = deps.findWindowFn ?? findWindow;
  const cmdWakeFn = deps.cmdWakeFn ?? cmdWake;

  if (!co.manager) {
    emit(`⚠ no company head — '${company}' has no manager set. Every member treated as crew-front (kobo-362 v1 ruling — a dept lead is not a company head, no silent fallback).`);
  }

  const roster = companyRoster(co);
  let sessions = await listSessionsFn();

  for (const member of roster) {
    let resolved = resolveMemberSession(member.oracle, sessions, findWindowFn);

    if (!resolved) {
      if (member.isManager) {
        emit(`⚠ ${member.oracle}: manager has no session — needs manual /head (no head-spawn verb yet, kobo-364 follow-up; report-only)`);
        continue;
      }
      // session-tier (2-tier, eq3 ruling): no session at all → cold-start via the
      // EXISTING `maw wake` verb (empirically confirmed it creates a session from
      // scratch for a registered-but-asleep oracle — reuse, don't reinvent).
      emit(`${member.oracle}: no session found — waking (maw wake, cold-start)`);
      try {
        await cmdWakeFn(member.oracle, {});
      } catch (e: any) {
        emit(`⚠ ${member.oracle}: wake failed — never set up? (${e.message}) — needs manual maw bud/wake (report-only)`);
        continue;
      }
      sessions = await listSessionsFn(); // refresh — the cold-start just changed the fleet
      resolved = resolveMemberSession(member.oracle, sessions, findWindowFn);
      if (!resolved) {
        emit(`⚠ ${member.oracle}: wake reported success but no session found afterward — report-only, investigate manually`);
        continue;
      }
      emit(`${member.oracle}: session created`);
    }

    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName, hostExecFn);

    if (member.isManager) {
      const ready = hasRole(panes, "👤") && hasRole(panes, "🎼") && hasRole(panes, "🔎");
      if (ready) { emit(`${member.oracle}: head-cell ready — skip`); continue; }
      emit(`⚠ ${member.oracle}: manager head-cell INCOMPLETE — needs manual /head (no head-spawn verb yet, kobo-364 follow-up; report-only)`);
      continue;
    }

    const ready = hasRole(panes, "🧭") && hasRole(panes, "🎼") && hasRole(panes, "⚒") && hasRole(panes, "🔎");
    if (ready) { emit(`${member.oracle}: crew ready — skip`); continue; }

    // crew-tier repair: an already-tagged front pane keeps its own pane-id as the
    // injection target; a session with NO crew ever spawned (fresh cold-start, or
    // just never run) has no @role tags yet — fall back to the resolved window
    // itself (tmux send-keys targets its active/first pane).
    const injectTarget = findRolePane(panes, "🧭") ?? resolved;
    emit(`${member.oracle}: crew incomplete/asleep — repairing (maw company crew spawn)`);
    try {
      await hostExecFn(`tmux send-keys -t ${shellArg(injectTarget)} C-u`);
      await hostExecFn(`tmux send-keys -t ${shellArg(injectTarget)} ${shellArg(`maw company crew spawn ${company}`)} Enter`);
      emit(`${member.oracle}: repair triggered — re-run 'up' to confirm`);
    } catch (e: any) {
      emit(`⚠ ${member.oracle}: repair injection failed (${e.message})`);
    }
  }

  return { ok: true };
}

/** `maw company up <company>` CLI-arg wrapper — mirrors runCrew's (args, emit) shape. */
export async function runCompanyUp(args: string[], emit: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  return companyUp(args[0], emit);
}

export async function companyDown(
  company: string | undefined,
  opts: { force?: boolean },
  emit: (line: string) => void,
  deps: CompanyFleetDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!company) return { ok: false, error: "usage: maw company down <company> [--force]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const hostExecFn = deps.hostExecFn ?? hostExec;
  const listSessionsFn = deps.listSessionsFn ?? listSessions;
  const findWindowFn = deps.findWindowFn ?? findWindow;
  const checkBusyGuardFn = deps.checkBusyGuardFn ?? checkBusyGuard;
  const teardownFn = deps.teardownCrewWindowsFn ?? teardownCrewWindows;

  const invokerPane = (process.env.TMUX_PANE || "").trim();
  const roster = companyRoster(co);
  const sessions = await listSessionsFn();

  for (const member of roster) {
    const resolved = resolveMemberSession(member.oracle, sessions, findWindowFn);
    if (!resolved) { emit(`${member.oracle}: no session found — nothing to tear down`); continue; }
    const sessionName = sessionNameOf(resolved);

    if (!opts.force) {
      const guard = await checkBusyGuardFn(member.oracle);
      if (guard.busy) {
        emit(`⚠ ${member.oracle}: BUSY — refusing teardown (pass --force to override)`);
        continue;
      }
    }

    const panes = await listSessionPanes(sessionName, hostExecFn);
    const rootPrefix = member.isManager ? "👤" : "🧭";
    const rootPaneId = findRolePane(panes, rootPrefix);

    const teardown = await teardownFn({ protectPaneId: rootPaneId ?? "" });
    for (const line of teardown.logs) emit(`${member.oracle}: ${line}`);
    if (!teardown.ok) { emit(`⚠ ${member.oracle}: teardown refused (${teardown.error})`); continue; }

    if (!rootPaneId) {
      emit(`${member.oracle}: no front/lead pane found — crew-tier swept, nothing else to kill`);
    } else if (rootPaneId === invokerPane) {
      emit(`${member.oracle}: front/lead pane IS the invoker — protected, not killed`);
    } else {
      try {
        await hostExecFn(`tmux kill-pane -t ${shellArg(rootPaneId)}`);
        emit(`${member.oracle}: killed front/lead pane ${rootPaneId}`);
      } catch {
        /* already gone — race with a manual kill is fine */
      }
    }
  }

  return { ok: true };
}

/** `maw company down <company> [--force]` CLI-arg wrapper — mirrors runCrew's (args, emit) shape. */
export async function runCompanyDown(args: string[], emit: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  const force = args.includes("--force");
  const company = args.find((a) => !a.startsWith("--"));
  return companyDown(company, { force }, emit);
}
