import { hostExec, listSessions } from "../transport/ssh";
import { tmux } from "../transport/tmux";
import { getGhqRoot } from "../../config/ghq-root";
import { writeFileSync } from "fs";
import { join } from "path";
import { parseWorktreePath } from "./worktree-layout";
import { resolveWorktreeTarget } from "../matcher/resolve-target";
import { loadFleetEntries } from "../../commands/shared/fleet-load";

/**
 * Clean up a single worktree by path.
 * Kills tmux window, removes worktree, prunes, deletes branch.
 */
export async function cleanupWorktree(wtPath: string): Promise<string[]> {
  const reposRoot = join(getGhqRoot(), "github.com");
  const log: string[] = [];

  const parsed = parseWorktreePath(wtPath, reposRoot);
  if (!parsed) {
    log.push(`not a worktree: ${wtPath.split("/").pop()!}`);
    return log;
  }

  const dirName = parsed.dirName;
  const mainPath = parsed.mainPath;
  const repo = parsed.repo;

  // 1. Find and kill tmux window
  const sessions = await listSessions();
  const wtName = parsed.wtName;
  const taskPart = wtName.replace(/^\d+-/, "");

  const allWindows = sessions.flatMap(s => s.windows.map(w => ({ name: w.name, session: s.name })));
  const resolved = resolveWorktreeTarget(taskPart, allWindows);
  switch (resolved.kind) {
    case "exact":
    case "fuzzy": {
      const { name: wName, session: sName } = resolved.match;
      try {
        await tmux.killWindow(`${sName}:${wName}`);
        log.push(`killed window ${sName}:${wName}`);
      } catch {
        log.push(`window already closed: ${wName}`);
      }
      break;
    }
    case "ambiguous":
      log.push(`✗ '${taskPart}' is ambiguous — matches ${resolved.candidates.length} windows:`);
      for (const c of resolved.candidates) {
        log.push(`    • ${c.session}:${c.name}`);
      }
      log.push(`  skipping window kill — use the full name to disambiguate`);
      // don't kill anything — safer than killing the wrong window
      break;
    case "none":
      // no running window to kill
      break;
  }

  // 2. Get branch, remove worktree
  let branch = "";
  try { branch = (await hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected: worktree may be corrupt */ }

  try {
    await hostExec(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
    await hostExec(`git -C '${mainPath}' worktree prune`);
    log.push(`removed worktree ${dirName}`);
  } catch (e: any) {
    log.push(`worktree remove failed: ${e.message || e}`);
  }

  // 3. Delete branch
  if (branch && branch !== "main" && branch !== "HEAD" && branch !== "unknown") {
    try {
      await hostExec(`git -C '${mainPath}' branch -d '${branch}'`);
      log.push(`deleted branch ${branch}`);
    } catch {
      log.push(`branch ${branch} not deleted (may have unmerged changes)`);
    }
  }

  // 4. Remove from fleet config
  try {
    for (const entry of loadFleetEntries()) {
      if (!entry.path) continue;
      const cfg = { ...entry.session };
      const before = cfg.windows?.length || 0;
      cfg.windows = (cfg.windows || []).filter((w: any) => w.repo !== repo);
      if (cfg.windows.length < before) {
        writeFileSync(entry.path, JSON.stringify(cfg, null, 2) + "\n");
        log.push(`removed from ${entry.file}`);
      }
    }
  } catch { /* fleet dir may not exist or contain invalid json */ }

  return log;
}
