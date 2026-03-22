import { ssh, listSessions } from "./ssh";
import { tmux } from "./tmux";
import { loadConfig } from "./config";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "./paths";

export interface WorktreeInfo {
  path: string;
  branch: string;
  repo: string; // org/repo
  mainRepo: string; // org/mainRepo
  name: string; // e.g. "1-freelance"
  status: "active" | "stale" | "orphan";
  tmuxWindow?: string; // window name if running
  fleetFile?: string; // fleet config if registered
}

/**
 * Scan all worktrees across ghq repos.
 * Classifies:
 *   active  — has a running tmux window
 *   stale   — exists on disk, no tmux window
 *   orphan  — git reports prunable
 */
export async function scanWorktrees(): Promise<WorktreeInfo[]> {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const fleetDir = FLEET_DIR;

  // 1. Find all .wt- directories
  let wtPaths: string[] = [];
  try {
    const raw = await ssh(`find ${ghqRoot} -maxdepth 4 -name '*.wt-*' -type d 2>/dev/null`);
    wtPaths = raw.split("\n").filter(Boolean);
  } catch { /* no worktrees */ }

  // 2. Get running tmux windows for matching
  const sessions = await listSessions();
  const runningWindows = new Set<string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      runningWindows.add(w.name);
    }
  }

  // 3. Load fleet configs for matching
  const fleetWindows = new Map<string, string>(); // repo -> fleet file
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const cfg = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      for (const w of cfg.windows || []) {
        if (w.repo) fleetWindows.set(w.repo, file);
      }
    }
  } catch { /* no fleet dir */ }

  // 4. Classify each worktree
  const results: WorktreeInfo[] = [];

  for (const wtPath of wtPaths) {
    const dirName = wtPath.split("/").pop()!;
    const parts = dirName.split(".wt-");
    if (parts.length < 2) continue;

    const mainRepoName = parts[0];
    const wtName = parts[1];

    // Derive org/repo path
    const relPath = wtPath.replace(ghqRoot + "/", "");
    const parentParts = relPath.split("/");
    parentParts.pop(); // remove wt dir
    const org = parentParts.join("/");
    const mainRepo = `${org}/${mainRepoName}`;
    const repo = `${org}/${dirName}`;

    // Get branch
    let branch = "";
    try {
      branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD 2>/dev/null`)).trim();
    } catch { branch = "unknown"; }

    // Match to tmux window — check fleet config or name pattern
    let tmuxWindow: string | undefined;
    const fleetFile = fleetWindows.get(repo);

    // Try to find matching window by name pattern
    for (const s of sessions) {
      for (const w of s.windows) {
        // Window names like "neo-freelance" match wt name "1-freelance"
        const taskPart = wtName.replace(/^\d+-/, "");
        if (w.name.endsWith(`-${taskPart}`) || w.name === taskPart) {
          tmuxWindow = w.name;
        }
      }
    }

    const status: WorktreeInfo["status"] = tmuxWindow ? "active" : "stale";

    results.push({
      path: wtPath,
      branch,
      repo,
      mainRepo,
      name: wtName,
      status,
      tmuxWindow,
      fleetFile,
    });
  }

  // 5. Check for orphaned worktrees (git reports them as prunable)
  // Collect unique main repos that have worktrees
  const mainRepos = [...new Set(results.map(r => r.mainRepo))];
  for (const mainRepo of mainRepos) {
    const mainPath = join(ghqRoot, mainRepo);
    try {
      const prunable = await ssh(`git -C '${mainPath}' worktree list --porcelain 2>/dev/null | grep -A1 'prunable' | grep 'worktree' | sed 's/worktree //'`);
      for (const orphanPath of prunable.split("\n").filter(Boolean)) {
        // Check if we already have this path
        const existing = results.find(r => r.path === orphanPath);
        if (existing) {
          existing.status = "orphan";
        } else {
          const dirName = orphanPath.split("/").pop() || "";
          results.push({
            path: orphanPath,
            branch: "(prunable)",
            repo: dirName,
            mainRepo,
            name: dirName,
            status: "orphan",
          });
        }
      }
    } catch { /* no prunable worktrees */ }
  }

  return results;
}

/**
 * Clean up a single worktree by path.
 * Kills tmux window, removes worktree, prunes, deletes branch.
 */
export async function cleanupWorktree(wtPath: string): Promise<string[]> {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const fleetDir = FLEET_DIR;
  const log: string[] = [];

  const dirName = wtPath.split("/").pop()!;
  const parts = dirName.split(".wt-");
  if (parts.length < 2) {
    log.push(`not a worktree: ${dirName}`);
    return log;
  }

  const mainRepoName = parts[0];
  const relPath = wtPath.replace(ghqRoot + "/", "");
  const parentParts = relPath.split("/");
  parentParts.pop();
  const org = parentParts.join("/");
  const mainPath = join(ghqRoot, org, mainRepoName);
  const repo = `${org}/${dirName}`;

  // 1. Find and kill tmux window
  const sessions = await listSessions();
  const wtName = parts[1];
  const taskPart = wtName.replace(/^\d+-/, "");

  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.endsWith(`-${taskPart}`) || w.name === taskPart) {
        try {
          await tmux.killWindow(`${s.name}:${w.name}`);
          log.push(`killed window ${s.name}:${w.name}`);
        } catch {
          log.push(`window already closed: ${w.name}`);
        }
      }
    }
  }

  // 2. Get branch, remove worktree
  let branch = "";
  try { branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch {}

  try {
    await ssh(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
    await ssh(`git -C '${mainPath}' worktree prune`);
    log.push(`removed worktree ${dirName}`);
  } catch (e: any) {
    log.push(`worktree remove failed: ${e.message || e}`);
  }

  // 3. Delete branch
  if (branch && branch !== "main" && branch !== "HEAD" && branch !== "unknown") {
    try {
      await ssh(`git -C '${mainPath}' branch -d '${branch}'`);
      log.push(`deleted branch ${branch}`);
    } catch {
      log.push(`branch ${branch} not deleted (may have unmerged changes)`);
    }
  }

  // 4. Remove from fleet config
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const filePath = join(fleetDir, file);
      const cfg = JSON.parse(readFileSync(filePath, "utf-8"));
      const before = cfg.windows?.length || 0;
      cfg.windows = (cfg.windows || []).filter((w: any) => w.repo !== repo);
      if (cfg.windows.length < before) {
        const { writeFileSync } = await import("fs");
        writeFileSync(filePath, JSON.stringify(cfg, null, 2) + "\n");
        log.push(`removed from ${file}`);
      }
    }
  } catch { /* fleet dir may not exist */ }

  return log;
}
