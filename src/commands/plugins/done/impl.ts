import { join } from "path";
import { listSessions } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
import { FLEET_DIR } from "../../../sdk";
import { takeSnapshot } from "../../../sdk";
import { tmux } from "../../../sdk";
import { normalizeTarget } from "../../../core/matcher/normalize-target";
import { signalParentInbox, autoSave } from "./done-autosave";
import { removeWorktreeViaConfig, removeWorktreeByGhqScan, removeFromFleetConfig } from "./done-worktree";

export interface DoneOpts {
  force?: boolean;
  dryRun?: boolean;
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
  for (const s of sessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; windowIndex = w.index; windowName = w.name; break; }
  }

  // 0. Signal parent inbox (#81) — write before kill so parent knows
  if (sessionName) {
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
