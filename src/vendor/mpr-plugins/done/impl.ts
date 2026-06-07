import { join } from "path";
import { listSessions } from "maw-js/sdk";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { takeSnapshot } from "maw-js/sdk";
import { tmux } from "maw-js/sdk";
import { normalizeTarget } from "maw-js/core/matcher/normalize-target";
import { signalParentInbox, autoSave } from "./done-autosave";
import { removeWorktreeViaConfig, removeWorktreeByGhqScan, removeFromFleetConfig } from "./done-worktree";

export interface DoneOpts {
  force?: boolean;
  dryRun?: boolean;
  /** Restrict window-name lookup to a specific tmux session. Used by done --all. */
  sessionName?: string;
}

type DoneWindow = { index: number; name: string; active: boolean };
type DoneSession = { name: string; windows: DoneWindow[] };

export interface DoneAllSummary {
  sessionName: string | null;
  processed: string[];
  skipped: string[];
}

async function currentSessionName(sessions: DoneSession[]): Promise<string | null> {
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
  const leadIndex = Math.min(...windows.map(w => w.index));
  return windows
    .filter(w => w.index !== leadIndex)
    .sort((a, b) => a.index - b.index);
}

/**
 * maw done <window-name> [--force] [--dry-run]
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
  let windowIndex: number | null = null;
  const searchSessions = opts.sessionName
    ? sessions.filter(s => s.name === opts.sessionName)
    : sessions;
  for (const s of searchSessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; windowIndex = w.index; windowName = w.name; break; }
  }

  // 0. Signal parent inbox (#81) — write before kill so parent knows
  if (sessionName && !opts.dryRun) {
    await signalParentInbox(windowName, sessionName, sessions as any);
  }

  // 0.5. Auto-save: send /rrr + git commit + push (unless --force)
  if (sessionName !== null && windowIndex !== null && !opts.force) {
    const exited = await autoSave(windowName, sessionName, opts);
    // autoSave returns void; dryRun path returns early inside
    if (opts.dryRun) return;
  } else if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] window '${windowName}' not running — nothing to auto-save`);
  }

  // 1. Kill tmux window
  if (sessionName !== null && windowIndex !== null) {
    try {
      await tmux.killWindow(`${sessionName}:${windowName}`);
      console.log(`  \x1b[32m✓\x1b[0m killed window ${sessionName}:${windowName}`);
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m could not kill window (may already be closed)`);
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m window '${windowName}' not running`);
  }

  // 2. Remove git worktree
  let removedWorktree = await removeWorktreeViaConfig(windowNameLower, reposRoot);
  if (!removedWorktree) {
    removedWorktree = await removeWorktreeByGhqScan(windowName, reposRoot);
  }
  if (!removedWorktree) {
    console.log(`  \x1b[90m○\x1b[0m no worktree to remove (may be a main window)`);
  }

  // 3. Remove from fleet config
  const removedFromConfig = removeFromFleetConfig(windowNameLower);
  if (!removedFromConfig) {
    console.log(`  \x1b[90m○\x1b[0m not in any fleet config`);
  }

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
  const sessions = await listSessions() as DoneSession[];
  const sessionName = await currentSessionName(sessions);
  if (!sessionName) {
    const reason = sessions.length === 0
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
