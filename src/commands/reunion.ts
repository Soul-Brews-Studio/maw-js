import { listSessions, hostExec } from "../ssh";
import { existsSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const SYNC_DIRS = ["memory/learnings", "memory/retrospectives", "memory/traces"];

/**
 * Resolve the main oracle repo root from a worktree cwd.
 * Uses git --git-common-dir which points to the shared .git in the main repo.
 */
async function resolveMainRepoRoot(cwd: string): Promise<string | null> {
  try {
    // git rev-parse --git-common-dir returns path to shared .git
    const commonDir = (await hostExec(`git -C '${cwd}' rev-parse --git-common-dir`)).trim();
    if (!commonDir || commonDir === ".git") return null; // already main repo

    // commonDir is something like /path/to/main-repo/.git
    // strip trailing /.git to get main repo root
    const mainGit = commonDir.startsWith("/") ? commonDir : join(cwd, commonDir);
    return dirname(mainGit);
  } catch {
    return null;
  }
}

/**
 * Sync new files from src dir to dst dir (skip existing).
 * Returns count of files copied.
 */
function syncDir(srcDir: string, dstDir: string): number {
  if (!existsSync(srcDir)) return 0;
  let count = 0;

  function walk(src: string, dst: string) {
    let entries: string[];
    try { entries = readdirSync(src, { withFileTypes: true } as any) as any; }
    catch { return; }

    for (const entry of entries as any[]) {
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (!existsSync(dstPath)) {
        try {
          mkdirSync(dst, { recursive: true });
          copyFileSync(srcPath, dstPath);
          count++;
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(srcDir, dstDir);
  return count;
}

export interface ReunionResult {
  mainRoot: string;
  synced: Record<string, number>;
  total: number;
}

/**
 * maw reunion [window]
 *
 * Sync ψ/memory/ from a worktree back to the main oracle repo.
 * Subdirs synced: memory/learnings, memory/retrospectives, memory/traces
 * Skip existing files (never overwrite main).
 */
export async function cmdReunion(windowName?: string): Promise<ReunionResult | null> {
  // 1. Resolve cwd
  let cwd = "";
  if (windowName) {
    const sessions = await listSessions();
    const wl = windowName.toLowerCase();
    let target = "";
    for (const s of sessions) {
      const w = s.windows.find(w => w.name.toLowerCase() === wl);
      if (w) { target = `${s.name}:${w.name}`; break; }
    }
    if (!target) {
      console.log(`  \x1b[33m⚠\x1b[0m reunion: window '${windowName}' not found, skipping`);
      return null;
    }
    try {
      cwd = (await hostExec(`tmux display-message -t '${target}' -p '#{pane_current_path}'`)).trim();
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m reunion: could not get cwd for ${target}`);
      return null;
    }
  } else {
    // Use current pane's cwd
    try {
      cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m reunion: not in tmux, cannot determine cwd`);
      return null;
    }
  }

  // 2. Find ψ/ in cwd
  const wtVault = join(cwd, "ψ");
  if (!existsSync(wtVault)) {
    console.log(`  \x1b[90m○\x1b[0m reunion: no ψ/ in ${cwd}, skipping`);
    return null;
  }

  // 3. Find main oracle repo
  const mainRoot = await resolveMainRepoRoot(cwd);
  if (!mainRoot) {
    console.log(`  \x1b[90m○\x1b[0m reunion: not a worktree (already main), skipping`);
    return null;
  }

  const mainVault = join(mainRoot, "ψ");

  // 4. Sync subdirs
  const synced: Record<string, number> = {};
  for (const subdir of SYNC_DIRS) {
    const src = join(wtVault, subdir);
    const dst = join(mainVault, subdir);
    const count = syncDir(src, dst);
    if (count > 0) synced[subdir] = count;
  }

  const total = Object.values(synced).reduce((a, b) => a + b, 0);

  // 5. Report
  if (total === 0) {
    console.log(`  \x1b[90m○\x1b[0m reunion: nothing new to sync to main (${mainRoot.split("/").pop()})`);
  } else {
    const parts = Object.entries(synced).map(([dir, n]) => {
      const label = dir.split("/").pop()!;
      return `${n} ${label}`;
    });
    console.log(`  \x1b[32m✓\x1b[0m reunion: synced ${parts.join(", ")} → ${mainRoot.split("/").pop()}/ψ/`);
  }

  return { mainRoot, synced, total };
}
