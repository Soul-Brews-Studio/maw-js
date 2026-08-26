import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { listSessions } from "maw-js/sdk";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { takeSnapshot } from "maw-js/sdk";
import { tmux } from "maw-js/sdk";
import { normalizeTarget } from "maw-js/core/matcher/normalize-target";
import { resolveOracle } from "maw-js/commands/shared/wake-resolve";
import { readTeamCharter, type TeamCharter } from "maw-js/vendor/mpr-plugins/team/team-charter";
import { findRepoRoot, resolveCharterPath } from "maw-js/vendor/mpr-plugins/team/team-liveness";
import { signalParentInbox, autoSave } from "./done-autosave";
import { removeWorktreeViaConfig, removeWorktreeByGhqScan, removeFromFleetConfig, warnRemainingWorktrees } from "./done-worktree";

export interface DoneOpts {
  force?: boolean;
  dryRun?: boolean;
  cleanBranch?: boolean;
  cwd?: string;
  /** Restrict window-name lookup to a specific tmux session. Used by done --all. */
  sessionName?: string;
  /** Optional oracle target for `maw done --all <oracle>`. */
  oracle?: string;
}

type DoneWindow = { index: number; name: string; active: boolean };
type DoneSession = { name: string; windows: DoneWindow[] };
type TeamCharterMember = TeamCharter["members"][number] & { isLead?: boolean };

export interface DoneAllSummary {
  sessionName: string | null;
  processed: string[];
  skipped: string[];
}

function doneAllSessionStem(name: string): string {
  return name.toLowerCase().replace(/^\d+-/, "").replace(/-oracle$/i, "");
}

function doneAllCompactStem(name: string): string {
  return doneAllSessionStem(name).replace(/[^a-z0-9]/g, "");
}

function normalizeWindowName(name: string): string {
  return name.trim().toLowerCase();
}

function windowIdentityVariants(raw: string): string[] {
  const clean = normalizeWindowName(raw);
  if (!clean) return [];
  const short = clean.replace(/-oracle$/i, "");
  return [...new Set([clean, short])];
}

function isLeadMember(member: TeamCharterMember): boolean {
  if (typeof member.isLead === "boolean") return member.isLead;
  return member.role === "lead" || member.role === "bridge";
}

function leadWindowCandidates(charter: TeamCharter | null): string[] {
  if (!charter) return [];
  const out = new Set<string>();
  for (const member of charter.members) {
    if (!isLeadMember(member)) continue;
    const raw = (member.name || member.role || "").trim();
    if (!raw) continue;
    for (const alias of windowIdentityVariants(raw)) out.add(alias);
  }
  return [...out];
}

function resolveTeamCharterPath(session: DoneSession): string | null {
  const stem = doneAllSessionStem(session.name);
  const repoRoot = findRepoRoot();
  const direct = resolveCharterPath(stem, repoRoot);
  if (direct) return direct;

  const candidates = [
    join(repoRoot, ".maw", "teams"),
    join(repoRoot, "ψ", "teams"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const path = join(dir, entry);
      try {
        const charter = readTeamCharter(path);
        const candidateNames = leadWindowCandidates(charter);
        if (!candidateNames.length) continue;
        const hasMatch = session.windows.some((window) => candidateNames.includes(normalizeWindowName(window.name)));
        if (hasMatch) return path;
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function currentSessionName(sessions: DoneSession[], oracle?: string): Promise<string | null> {
  if (oracle) {
    const candidate = oracle.replace(/-oracle$/i, "").trim();
    if (candidate) {
      const wanted = candidate.toLowerCase();
      const exact = sessions.find(session => doneAllSessionStem(session.name) === wanted);
      if (exact) return exact.name;

      // `maw wake` accepts fuzzy oracle names via resolveOracle. Once that
      // resolver has produced the canonical repo name, accept the same common
      // fleet-session spelling variants here (e.g. v3 → arra-oracle-v3-oracle
      // may have a live session named 33-arraoraclev3). Keep it unique because
      // done --all is destructive.
      const compactWanted = wanted.replace(/[^a-z0-9]/g, "");
      const compactMatches = sessions.filter(session => doneAllCompactStem(session.name) === compactWanted);
      if (compactMatches.length === 1) return compactMatches[0]!.name;
      if (compactMatches.length > 1) return null;
    }
  }

  try {
    const current = (await tmux.run("display-message", "-p", "#{session_name}")).trim();
    if (current && sessions.some(s => s.name === current)) return current;
  } catch { /* outside tmux or tmux unavailable */ }

  // `done --all` is destructive. If tmux cannot tell us the current session
  // and multiple sessions exist, refuse to guess from per-session "active"
  // windows because every session may have one.
  return sessions.length === 1 ? sessions[0].name : null;
}

function nonLeadWindows(session: DoneSession): DoneWindow[] {
  const windows = [...session.windows];
  if (windows.length === 0) return [];
  const lead = leadWindow(session);
  const leadIndex = lead?.index ?? Math.min(...windows.map((w) => w.index));
  return windows
    .filter(w => w.index !== leadIndex)
    .sort((a, b) => a.index - b.index);
}

function missingDoneTargetMessage(windowName: string): string {
  const hint = windowName.toLowerCase() === "all" ? "\n  did you mean `maw done --all`?" : "";
  return `no done target matched '${windowName}'${hint}`;
}

function failMissingDoneTarget(windowName: string): never {
  const message = missingDoneTargetMessage(windowName);
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
  throw new Error(message);
}

function leadWindow(session: DoneSession): DoneWindow | null {
  if (session.windows.length === 0) return null;

  const charterPath = resolveTeamCharterPath(session);
  if (charterPath) {
    let charter: TeamCharter | null = null;
    try {
      charter = readTeamCharter(charterPath);
    } catch {
      console.warn(`  ⚠ could not read team charter ${charterPath}; falling back to first window`);
    }
    if (charter) {
      const candidates = new Set(leadWindowCandidates(charter));
      const found = session.windows.filter((window) => candidates.has(normalizeWindowName(window.name)));
      if (found.length > 0) {
        return found.sort((a, b) => a.index - b.index)[0] ?? null;
      }
      console.warn(`  ⚠ team charter ${charterPath} has no matching lead window; falling back to first window`);
    }
  }

  const leadIndex = Math.min(...session.windows.map(w => w.index));
  if (charterPath) console.warn(`  ⚠ fallback lead-window heuristic for session ${session.name}: using lowest tmux index`);
  return session.windows.find(w => w.index === leadIndex) ?? null;
}

async function currentTmuxIdentity(): Promise<{ sessionName: string; windowIndex: number } | null> {
  try {
    const raw = (await tmux.run("display-message", "-p", "#{session_name}\t#{window_index}")).trim();
    const [sessionName, indexRaw] = raw.split("\t");
    const windowIndex = Number(indexRaw);
    if (sessionName && Number.isInteger(windowIndex)) return { sessionName, windowIndex };
  } catch {
    // Outside tmux or tmux unavailable. Keep from blocking; lead context is
    // impossible to verify from this execution path.
    return null;
  }
  return null;
}

async function assertDoneMayTargetWindow(
  session: DoneSession,
  windowIndex: number,
  windowName: string,
): Promise<void> {
  const lead = leadWindow(session);
  if (!lead || lead.index !== windowIndex) return;

  const current = await currentTmuxIdentity();
  if (!current) {
    return;
  }
  if (current?.sessionName === session.name && current.windowIndex === lead.index) return;

  const message = `refusing to done lead window '${windowName}' in session '${session.name}' from a non-lead context`;
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
  console.error(`  \x1b[90m  run from the lead window, or target a non-lead agent window\x1b[0m`);
  throw new Error(message);
}

/**
 * maw done <window-name> [--force] [--dry-run] [--clean-branch]
 *
 * Clean up a finished worktree window:
 * 0. Send /rrr to agent + git auto-save (unless --force)
 * 1. Kill the tmux window
 * 2. Remove git worktree (if it is one)
 * 3. Remove from fleet config JSON
 */
export async function cmdDone(windowName_: string, opts: DoneOpts = {}) {
  let windowName = normalizeTarget(windowName_);
  const sessions = await listSessions();
  const reposRoot = join(getGhqRoot(), "github.com");

  const windowNameLower = windowName.toLowerCase();
  let sessionName: string | null = null;
  let matchedSession: DoneSession | null = null;
  let windowIndex: number | null = null;
  const searchSessions = opts.sessionName
    ? sessions.filter(s => s.name === opts.sessionName)
    : sessions;
  for (const s of searchSessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; matchedSession = s; windowIndex = w.index; windowName = w.name; break; }
  }

  if (matchedSession && windowIndex !== null) {
    await assertDoneMayTargetWindow(matchedSession, windowIndex, windowName);
  }

  // 0. Signal parent inbox (#81) — write before kill so parent knows
  if (sessionName && !opts.dryRun) {
    await signalParentInbox(windowName, sessionName, sessions as any);
  }

  // 0.5. Auto-save: send /rrr + git commit + push (unless --force)
  if (sessionName !== null && windowIndex !== null && !opts.force) {
    await autoSave(windowName, sessionName, opts);
    // NOTE: no early return on dry-run — continue through the (dry-run-guarded)
    // kill-window + worktree-resolution steps so the preview reflects what would
    // actually happen (worktree resolvable or not), instead of an optimistic claim.
  } else if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] window '${windowName}' not running — nothing to auto-save`);
  }

  // 1. Kill tmux window
  if (sessionName !== null && windowIndex !== null) {
    if (opts.dryRun) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would kill window ${sessionName}:${windowName}`);
    } else {
      try {
        await tmux.killWindow(`${sessionName}:${windowName}`);
        console.log(`  \x1b[32m✓\x1b[0m killed window ${sessionName}:${windowName}`);
      } catch {
        console.log(`  \x1b[33m⚠\x1b[0m could not kill window (may already be closed)`);
      }
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m window '${windowName}' not running`);
  }

  // 2. Remove git worktree
  let removedWorktree = await removeWorktreeViaConfig(windowNameLower, reposRoot, opts);
  if (!removedWorktree) {
    removedWorktree = await removeWorktreeByGhqScan(windowName, reposRoot, opts);
  }
  if (!removedWorktree) {
    console.log(`  \x1b[90m○\x1b[0m no worktree to remove (may be a main window)`);
  } else if (!opts.dryRun && opts.cwd) {
    await warnRemainingWorktrees(windowName, reposRoot);
  }

  const matchedWindow = sessionName !== null && windowIndex !== null;
  if (opts.dryRun) {
    if (!matchedWindow && !removedWorktree) failMissingDoneTarget(windowName);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove '${windowNameLower}' from fleet config if present`);
    console.log();
    return;
  }

  // 3. Remove from fleet config
  const removedFromConfig = removeFromFleetConfig(windowNameLower);
  if (!removedFromConfig) {
    console.log(`  \x1b[90m○\x1b[0m not in any fleet config`);
  }
  if (!matchedWindow && !removedWorktree && !removedFromConfig) failMissingDoneTarget(windowName);

  // Snapshot after done
  takeSnapshot("done").catch(() => {});

  console.log();
}

/**
 * maw done --all [--force] [--dry-run]
 *
 * Batch-clean all non-lead windows in the current tmux session. Reuses the
 * single-window lifecycle so /rrr, auto-save, worktree cleanup, fleet cleanup,
 * and snapshots stay consistent with `maw done <window>`.
 */
export async function cmdDoneAll(opts: DoneOpts = {}): Promise<DoneAllSummary> {
  const originalCwd = process.cwd();
  const sessions = await listSessions() as DoneSession[];
  let sessionName: string | null = null;
  try {
    if (opts.oracle) {
      const resolved = await resolveOracle(opts.oracle);
      process.chdir(resolved.repoPath);
      sessionName = await currentSessionName(sessions, resolved.repoName);
    } else {
      sessionName = await currentSessionName(sessions);
    }
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
  }

  if (!sessionName) {
    const reason = opts.oracle
      ? `no tmux session found for oracle '${opts.oracle}'`
      : sessions.length === 0
        ? "no tmux sessions to clean"
        : "could not identify current tmux session; run inside tmux";
    console.log(`  \x1b[90m○\x1b[0m ${reason}`);
    return { sessionName: null, processed: [], skipped: [] };
  }

  const session = sessions.find(s => s.name === sessionName);
  if (!session) {
    console.log(`  \x1b[90m○\x1b[0m current tmux session '${sessionName}' not found`);
    return { sessionName, processed: [], skipped: [] };
  }

  const targets = nonLeadWindows(session);
  if (targets.length === 0) {
    console.log(`  \x1b[90m○\x1b[0m no non-lead windows in ${sessionName}`);
    return { sessionName, processed: [], skipped: [] };
  }

  const mode = opts.dryRun ? "would process" : "processing";
  console.log(`  \x1b[36m⬡\x1b[0m ${mode} ${targets.length} non-lead window(s) in ${sessionName}`);

  const processed: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    console.log(`\n\x1b[36m→\x1b[0m done ${sessionName}:${target.name}`);
    try {
      await cmdDone(target.name, { ...opts, sessionName });
      processed.push(target.name);
    } catch (e: any) {
      skipped.push(target.name);
      console.log(`  \x1b[33m⚠\x1b[0m skipped ${target.name}: ${e?.message || e}`);
    }
  }

  const verb = opts.dryRun ? "would process" : "processed";
  console.log(`  \x1b[32m✓\x1b[0m done --all ${verb} ${processed.length} window(s)${skipped.length ? `, skipped ${skipped.length}` : ""}`);
  return { sessionName, processed, skipped };
}
