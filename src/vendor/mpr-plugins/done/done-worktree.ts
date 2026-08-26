import { hostExec } from "maw-js/sdk";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fleetDirsForRead } from "maw-js/commands/shared/fleet-load";
import { parseWorktreePath } from "maw-js/core/fleet/worktree-layout";

export interface DoneBranchCleanupOpts {
  cleanBranch?: boolean;
  branchBase?: string;
  dryRun?: boolean;
  cwd?: string;
  force?: boolean;
}

function activeFleetConfigFiles(): Array<{ file: string; path: string }> {
  const filesByName = new Map<string, { file: string; path: string }>();
  for (const fleetDir of fleetDirsForRead()) {
    let files: string[];
    try {
      files = readdirSync(fleetDir).filter(f => f.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (!filesByName.has(file)) filesByName.set(file, { file, path: join(fleetDir, file) });
    }
  }
  return [...filesByName.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isNotWorkingTreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a working tree/i.test(message);
}

function isDirtyWorktreeRemovalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has uncommitted changes; rerun maw done --force/i.test(message);
}

function archivePathFor(wtPath: string): string {
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z_.-]/g, "-");
  const safeBase = basename(wtPath).replace(/[^0-9A-Za-z_.-]/g, "-");
  return `/tmp/maw-done-orphan-worktrees/${safeBase}-${stamp}`;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await hostExec(`test -d ${shellArg(path)}`);
    return true;
  } catch {
    return false;
  }
}

async function movePrunedWorktreeDir(wtPath: string, mainPath: string): Promise<boolean> {
  if (!(await dirExists(wtPath))) return false;
  const archived = archivePathFor(wtPath);
  try {
    await hostExec(`mkdir -p ${shellArg(dirname(archived))}`);
    await hostExec(`mv ${shellArg(wtPath)} ${shellArg(archived)}`);
    await hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
    console.log(`  \x1b[32m✓\x1b[0m moved orphan directory ${basename(wtPath)} to ${archived}`);
    return true;
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m orphan directory move failed: ${e?.message || e}`);
    return false;
  }
}

export function windowMatchesWorktreeSuffix(windowName: string, wtName: string): boolean {
  const win = windowName.toLowerCase();
  // strip a leading numbered slot ("1-wt-foo" -> "wt-foo") so the worktree's own
  // slug is compared, not its slot index.
  const wtSuffix = wtName.replace(/^\d+-/, "").toLowerCase();
  if (!wtSuffix) return false;
  // A window is named "<oracle-or-session>-<wtName>". The oracle name may itself
  // contain hyphens (e.g. "pilot-hello-disposable"), so the old first-hyphen strip
  // broke the match. Match the worktree slug as the window's tail, bounded by a
  // hyphen so a suffix cannot substring-match a longer one ("wt-repro1" vs
  // "wt-repro11"). Genuine multi-matches are disambiguated by the caller.
  return win === wtSuffix || win.endsWith(`-${wtSuffix}`);
}

async function findMatchingWorktreePaths(windowName: string, reposRoot: string): Promise<string[]> {
  const ghqOut = await hostExec(`find ${shellArg(reposRoot)} -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`);
  const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
  return allWtPaths.filter(p => {
    const parsed = parseWorktreePath(p, reposRoot);
    if (!parsed) return false;
    return windowMatchesWorktreeSuffix(windowName, parsed.wtName);
  });
}

async function cwdMainPath(cwd: string | undefined, reposRoot: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    const top = (await hostExec(`git -C ${shellArg(cwd)} rev-parse --show-toplevel`)).trim();
    if (!top) return null;
    const parsed = parseWorktreePath(top, reposRoot);
    return parsed?.mainPath ?? top;
  } catch {
    return null;
  }
}

function branchBaseFor(mainPath: string, opts: DoneBranchCleanupOpts = {}): string {
  if (opts.branchBase) return opts.branchBase;
  const normalized = mainPath.split("\\").join("/");
  if (normalized.endsWith("/Soul-Brews-Studio/maw-js") || normalized.includes("/github.com/Soul-Brews-Studio/maw-js")) {
    return "alpha";
  }
  return "main";
}

function isProtectedBranch(branch: string, baseBranch: string): boolean {
  return branch === "HEAD" || branch === "main" || branch === "master" || branch === "alpha" || branch === baseBranch;
}

async function ghMergedPrExists(branch: string): Promise<"yes" | "no" | "unavailable"> {
  try {
    const out = await hostExec(`gh pr list --head ${shellArg(branch)} --state merged --json number --limit 1`);
    const parsed = JSON.parse(out || "[]");
    return Array.isArray(parsed) && parsed.length > 0 ? "yes" : "no";
  } catch {
    return "unavailable";
  }
}

export async function cleanupDoneBranch(
  mainPath: string,
  branch: string,
  opts: DoneBranchCleanupOpts = {},
): Promise<void> {
  const baseBranch = branchBaseFor(mainPath, opts);
  if (!branch || isProtectedBranch(branch, baseBranch)) return;

  const quotedMain = shellArg(mainPath);
  const quotedBranch = shellArg(branch);
  if (opts.cleanBranch) {
    try {
      await hostExec(`git -C ${quotedMain} branch -D ${quotedBranch}`);
      console.log(`  \x1b[32m✓\x1b[0m force-deleted branch ${branch}`);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): force delete failed: ${e?.message || e}`);
    }
    return;
  }

  try {
    await hostExec(`git -C ${quotedMain} merge-base --is-ancestor ${quotedBranch} ${shellArg(baseBranch)}`);
    await hostExec(`git -C ${quotedMain} branch -d ${quotedBranch}`);
    console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch} (merged into ${baseBranch})`);
    return;
  } catch {
    // Not an ancestor of the configured base, or local refs are unavailable.
  }

  const prState = await ghMergedPrExists(branch);
  if (prState === "yes") {
    try {
      await hostExec(`git -C ${quotedMain} branch -D ${quotedBranch}`);
      console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch} (merged PR)`);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): delete failed after merged PR proof: ${e?.message || e}`);
    }
    return;
  }

  if (prState === "unavailable") {
    console.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): gh unavailable and not merged into ${baseBranch}`);
  } else {
    console.log(`  \x1b[90m○\x1b[0m branch retained (${branch}): not merged into ${baseBranch} and no merged PR found`);
  }
}

/**
 * Remove a git worktree via fleet config lookup.
 * Returns true if a worktree was removed.
 */
export async function removeWorktreeViaConfig(
  windowNameLower: string,
  reposRoot: string,
  opts: DoneBranchCleanupOpts = {},
): Promise<boolean> {
  try {
    for (const { file, path } of activeFleetConfigFiles()) {
      let config: any;
      try {
        config = JSON.parse(readFileSync(path, "utf-8"));
      } catch { continue; }
      const win = (config.windows || []).find((w: any) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo && !win?.worktree) continue;

      // Prefer the recorded worktree slot (org/repo/agents/N-slug). win.repo holds
      // only the BASE repo for a --work worker, so resolving win.repo would target
      // the main repo (parseWorktreePath → null → break) and leave the slot behind.
      // Legacy records without win.worktree fall through to the ghq scan below.
      const target: string = win.worktree ?? win.repo;
      const fullPath = join(reposRoot, target);
      const parsed = parseWorktreePath(fullPath, reposRoot);
      if (!parsed) break;
      const mainPath = parsed.mainPath;

      try {
        if (opts.dryRun) {
          console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${target}`);
          return true;
        }
        let branch = "";
        try { branch = (await hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        // Try without --force first; only --force for dirty worktrees (#2065/#2098).
        try {
          await hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(fullPath)}`);
        } catch (removeErr: any) {
          const msg = String(removeErr.message || removeErr);
          if (/modified or untracked|contains modified/i.test(msg)) {
            if (!opts.force) {
              throw new Error(`worktree remove failed and ${fullPath} has uncommitted changes; rerun maw done --force to delete it`);
            }
            console.log(`  \x1b[33m⚠\x1b[0m worktree has uncommitted changes, force-removing (--force)`);
            await hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(fullPath)} --force`);
          } else {
            throw removeErr;
          }
        }
        await hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${target}`);
        await cleanupDoneBranch(mainPath, branch, opts);
        return true;
      } catch (e: any) {
        if (isDirtyWorktreeRemovalError(e)) throw e;
        if (isNotWorkingTreeError(e) && await movePrunedWorktreeDir(fullPath, mainPath)) {
          return true;
        }
        console.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e.message || e}`);
      }
      break;
    }
  } catch (e) {
    if (isDirtyWorktreeRemovalError(e)) throw e;
    console.error(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e}`);
  }
  return false;
}

/**
 * Fallback: scan ghq for legacy .wt- and nested agents dirs matching the window name suffix.
 * EXACT match only — substring matching killed unrelated worktrees (#60).
 * Returns true if any worktrees were removed.
 */
export async function removeWorktreeByGhqScan(
  windowName: string,
  reposRoot: string,
  opts: DoneBranchCleanupOpts = {},
): Promise<boolean> {
  let removed = false;
  try {
    const suffix = windowName.replace(/^[^-]+-/, ""); // e.g. "mother-schedule" → "schedule"
    const exactMatch = await findMatchingWorktreePaths(windowName, reposRoot);
    let matches = exactMatch;
    if (matches.length > 1) {
      const mainPath = await cwdMainPath(opts.cwd, reposRoot);
      if (mainPath) {
        const scoped = matches.filter((p) => parseWorktreePath(p, reposRoot)?.mainPath === mainPath);
        if (scoped.length === 1) {
          matches = scoped;
          console.log(`  \x1b[36m⬡\x1b[0m scoped ambiguous worktree '${suffix}' to cwd repo ${mainPath}`);
        }
      }
    }
    if (matches.length > 1) {
      console.error(`  \x1b[31m✗\x1b[0m refusing to remove worktree '${suffix}' — matches ${matches.length} repos:`);
      for (const wtPath of matches) console.error(`  \x1b[90m    • ${wtPath}\x1b[0m`);
      console.error(`  \x1b[90m  use fleet config or remove the exact worktree manually\x1b[0m`);
      return false;
    }
    for (const wtPath of matches) {
      const parsed = parseWorktreePath(wtPath, reposRoot);
      if (!parsed) continue;
      const base = parsed.dirName;
      const mainPath = parsed.mainPath;
      try {
        if (opts.dryRun) {
          console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${base}`);
          removed = true;
          continue;
        }
        let branch = "";
        try { branch = (await hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        // Try without --force first; only --force for dirty worktrees (#2065/#2098).
        try {
          await hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(wtPath)}`);
        } catch (removeErr: any) {
          const msg = String(removeErr.message || removeErr);
          if (/modified or untracked|contains modified/i.test(msg)) {
            if (!opts.force) {
              throw new Error(`worktree remove failed and ${wtPath} has uncommitted changes; rerun maw done --force to delete it`);
            }
            console.log(`  \x1b[33m⚠\x1b[0m worktree has uncommitted changes, force-removing (--force)`);
            await hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(wtPath)} --force`);
          } else {
            throw removeErr;
          }
        }
        await hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        await cleanupDoneBranch(mainPath, branch, opts);
      } catch (e) {
        if (isDirtyWorktreeRemovalError(e)) throw e;
        if (isNotWorkingTreeError(e) && await movePrunedWorktreeDir(wtPath, mainPath)) {
          removed = true;
          continue;
        }
        console.error(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e}`);
      }
    }
  } catch (e) {
    if (isDirtyWorktreeRemovalError(e)) throw e;
    console.error(`  \x1b[33m⚠\x1b[0m worktree scan failed: ${e}`);
  }
  return removed;
}

export async function warnRemainingWorktrees(windowName: string, reposRoot: string): Promise<string[]> {
  let matches: string[] = [];
  try {
    matches = await findMatchingWorktreePaths(windowName, reposRoot);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m cross-repo worktree scan failed: ${e?.message || e}`);
    return [];
  }
  if (matches.length === 0) return [];

  console.log(`  \x1b[33m⚠\x1b[0m ${matches.length} same-member worktree(s) still exist in other repo(s):`);
  for (const match of matches) console.log(`  \x1b[90m    • ${match}\x1b[0m`);
  console.log(`  \x1b[90m  inspect them or run maw cleanup --worktrees before respawning\x1b[0m`);
  return matches;
}

/** Remove a window entry from all fleet config JSON files. Returns true if any file was updated. */
export function removeFromFleetConfig(windowNameLower: string): boolean {
  let removed = false;
  try {
    for (const { file, path: filePath } of activeFleetConfigFiles()) {
      const config = JSON.parse(readFileSync(filePath, "utf-8"));
      const before = config.windows?.length || 0;
      config.windows = (config.windows || []).filter((w: any) => w.name.toLowerCase() !== windowNameLower);
      if (config.windows.length < before) {
        writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m removed from ${file}`);
        removed = true;
      }
    }
  } catch { /* fleet dir may not exist */ }
  return removed;
}
