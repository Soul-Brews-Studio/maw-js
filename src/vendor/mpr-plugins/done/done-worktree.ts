import { hostExec } from "maw-js/sdk";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fleetDirsForRead } from "maw-js/commands/shared/fleet-load";
import { parseWorktreePath } from "maw-js/core/fleet/worktree-layout";

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

/**
 * Remove a git worktree via fleet config lookup.
 * Returns true if a worktree was removed.
 */
export async function removeWorktreeViaConfig(
  windowNameLower: string,
  reposRoot: string,
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
        let branch = "";
        try { branch = (await hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await hostExec(`git -C '${mainPath}' worktree remove '${fullPath}' --force`);
        await hostExec(`git -C '${mainPath}' worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${win.repo}`);
        if (branch && branch !== "main" && branch !== "HEAD") {
          try { await hostExec(`git -C '${mainPath}' branch -d '${branch}'`); console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch { /* expected */ }
        }
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
    if (exactMatch.length > 1) {
      console.error(`  \x1b[31m✗\x1b[0m refusing to remove worktree '${suffix}' — matches ${exactMatch.length} repos:`);
      for (const wtPath of exactMatch) console.error(`  \x1b[90m    • ${wtPath}\x1b[0m`);
      console.error(`  \x1b[90m  use fleet config or remove the exact worktree manually\x1b[0m`);
      return false;
    }
    for (const wtPath of exactMatch) {
      const parsed = parseWorktreePath(wtPath, reposRoot);
      if (!parsed) continue;
      const base = parsed.dirName;
      const mainPath = parsed.mainPath;
      try {
        let branch = "";
        try { branch = (await hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await hostExec(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
        await hostExec(`git -C '${mainPath}' worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        if (branch && branch !== "main" && branch !== "HEAD") {
          try { await hostExec(`git -C '${mainPath}' branch -d '${branch}'`); console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch { /* expected */ }
        }
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
