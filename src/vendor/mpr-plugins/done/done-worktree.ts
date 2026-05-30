import { hostExec } from "maw-js/sdk";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fleetDirsForRead } from "maw-js/commands/shared/fleet-load";
import { parseWorktreePath } from "maw-js/core/fleet/worktree-layout";

export interface DoneBranchCleanupOpts {
  cleanBranch?: boolean;
  branchBase?: string;
  dryRun?: boolean;
  cwd?: string;
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
      if (!win?.repo) continue;

      const fullPath = join(reposRoot, win.repo);
      const parsed = parseWorktreePath(fullPath, reposRoot);
      if (!parsed) break;
      const mainPath = parsed.mainPath;

      try {
        if (opts.dryRun) {
          console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${win.repo}`);
          return true;
        }
        let branch = "";
        try { branch = (await hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await hostExec(`git -C '${mainPath}' worktree remove '${fullPath}' --force`);
        await hostExec(`git -C '${mainPath}' worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${win.repo}`);
        await cleanupDoneBranch(mainPath, branch, opts);
        return true;
      } catch (e: any) {
        console.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e.message || e}`);
      }
      break;
    }
  } catch (e) { console.error(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e}`); }
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
    const safeRoot = reposRoot.replace(/'/g, "'\''");
    const ghqOut = await hostExec(`find '${safeRoot}' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`);
    const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
    const exactMatch = allWtPaths.filter(p => {
      const parsed = parseWorktreePath(p, reposRoot);
      if (!parsed) return false;
      const wtSuffix = parsed.wtName.replace(/^\d+-/, "");
      return wtSuffix.toLowerCase() === suffix.toLowerCase();
    });
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
        await hostExec(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
        await hostExec(`git -C '${mainPath}' worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        await cleanupDoneBranch(mainPath, branch, opts);
      } catch (e) { console.error(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e}`); }
    }
  } catch (e) { console.error(`  \x1b[33m⚠\x1b[0m worktree scan failed: ${e}`); }
  return removed;
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
