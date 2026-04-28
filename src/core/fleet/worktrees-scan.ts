import { hostExec, listSessions } from "../transport/ssh";
import { getGhqRoot } from "../../config/ghq-root";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../paths";
import { resolveWorktreeTarget } from "../matcher/resolve-target";

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
  const reposRoot = join(getGhqRoot(), "github.com");
  const fleetDir = FLEET_DIR;

  // 1. Find all .wt- directories
  let wtPaths: string[] = [];
  try {
    const raw = await hostExec(`find ${reposRoot} -maxdepth 4 -name '*.wt-*' -type d 2>/dev/null`);
    wtPaths = raw.split("\n").filter(Boolean);
  } catch { /* no worktrees */ }

  // 2. Get running tmux windows for matching
  // listSessions() can throw if tmux is down or SSH fails — treat as empty
  // (all worktrees will classify as stale, which is correct: no windows running).
  let sessions: Awaited<ReturnType<typeof listSessions>> = [];
  try {
    sessions = await listSessions();
  } catch { /* tmux unavailable — proceed with no running windows */ }
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
    const relPath = wtPath.replace(reposRoot + "/", "");
    const parentParts = relPath.split("/");
    parentParts.pop(); // remove wt dir
    const org = parentParts.join("/");
    const mainRepo = `${org}/${mainRepoName}`;
    const repo = `${org}/${dirName}`;

    // Get branch
    let branch = "";
    try {
      branch = (await hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD 2>/dev/null`)).trim();
    } catch { branch = "unknown"; }

    // Match to tmux window — check fleet config or name pattern
    let tmuxWindow: string | undefined;
    const fleetFile = fleetWindows.get(repo);

    // Try to find matching window by name pattern
    // Window names like "neo-freelance" match wt name "1-freelance"
    const taskPart = wtName.replace(/^\d+-/, "");
    // #823 Bug C — dedupe windows by name across sessions. Without this, a
    // window named X that exists in 2 sessions surfaces as 2 candidates in
    // the ambiguous-match list, manufacturing phantom duplicates.
    const allWindows = [
      ...new Map(sessions.flatMap(s => s.windows).map(w => [w.name, w])).values()
    ];
    const resolved = resolveWorktreeTarget(taskPart, allWindows);
    switch (resolved.kind) {
      case "exact":
      case "fuzzy":
        tmuxWindow = resolved.match.name;
        break;
      case "ambiguous":
        console.error(`  \x1b[31m✗\x1b[0m '${taskPart}' is ambiguous — matches ${resolved.candidates.length} windows:`);
        for (const c of resolved.candidates) {
          console.error(`  \x1b[90m    • ${c.name}\x1b[0m`);
        }
        console.error(`  \x1b[90m  leaving worktree ${wtName} unbound (status: stale)\x1b[0m`);
        // tmuxWindow stays undefined → status = stale
        break;
      case "none":
        // no running window → status = stale
        break;
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
    const mainPath = join(reposRoot, mainRepo);
    try {
      const prunable = await hostExec(`git -C '${mainPath}' worktree list --porcelain 2>/dev/null | grep -A1 'prunable' | grep 'worktree' | sed 's/worktree //'`);
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
