import { hostExec } from "../../../sdk";
import { FLEET_DIR } from "../../../sdk";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Remove a git worktree via fleet config lookup.
 * Returns true if a worktree was removed.
 */
export async function removeWorktreeViaConfig(
  windowNameLower: string,
  reposRoot: string,
): Promise<boolean> {
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      const win = (config.windows || []).find((w: any) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo) continue;

      const fullPath = join(reposRoot, win.repo);
      if (!win.repo.includes(".wt-")) break;

      const parts = win.repo.split("/");
      const wtDir = parts.pop()!;
      const org = parts.join("/");
      const mainRepo = wtDir.split(".wt-")[0];
      const mainPath = join(reposRoot, org, mainRepo);

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
 * Fallback: scan ghq for .wt- dirs matching the window name suffix.
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
    const ghqOut = await hostExec(`find ${reposRoot} -maxdepth 3 -name '*.wt-*' -type d 2>/dev/null`);
    const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
    const exactMatch = allWtPaths.filter(p => {
      const base = p.split("/").pop()!;
      const wtSuffix = base.replace(/^.*\.wt-(?:\d+-)?/, "");
      return wtSuffix.toLowerCase() === suffix.toLowerCase();
    });
    for (const wtPath of exactMatch) {
      const base = wtPath.split("/").pop()!;
      const mainRepo = base.split(".wt-")[0];
      const mainPath = wtPath.replace(base, mainRepo);
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
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const filePath = join(FLEET_DIR, file);
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
