import { hostExec, listSessions } from "../transport/ssh";
import { getGhqRoot } from "../../config/ghq-root";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseWorktreePath } from "./worktree-layout";
import { fleetDirForWrite, fleetDirsForRead, uniqueDirs } from "./paths";
import { resolveWorktreeWindow } from "./worktree-window-match";
import type { Session } from "../runtime/find-window";

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

export interface ScanWorktreesDeps {
  hostExec: (cmd: string) => Promise<string>;
  listSessions: () => Promise<Session[]>;
  getGhqRoot: () => string;
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: "utf-8") => string;
  /** Legacy single-dir override kept for tests and older callers. */
  fleetDir: string;
  /** State-first fleet dirs; when omitted, XDG state falls back to legacy config. */
  fleetDirs?: string[];
  error: (...args: unknown[]) => void;
}

function scanDeps(overrides: Partial<ScanWorktreesDeps>): ScanWorktreesDeps {
  return {
    hostExec: overrides.hostExec ?? hostExec,
    listSessions: overrides.listSessions ?? (listSessions as unknown as () => Promise<Session[]>),
    getGhqRoot: overrides.getGhqRoot ?? getGhqRoot,
    readdirSync: overrides.readdirSync ?? (readdirSync as unknown as ScanWorktreesDeps["readdirSync"]),
    readFileSync: overrides.readFileSync ?? (readFileSync as unknown as ScanWorktreesDeps["readFileSync"]),
    fleetDir: overrides.fleetDir ?? fleetDirForWrite(),
    fleetDirs: overrides.fleetDirs ?? (overrides.fleetDir ? [overrides.fleetDir] : fleetDirsForRead()),
    error: overrides.error ?? console.error,
  };
}

/**
 * Scan all worktrees across ghq repos.
 * Classifies:
 *   active  — has a running tmux window
 *   stale   — exists on disk, no tmux window
 *   orphan  — git reports prunable
 */
export async function scanWorktrees(deps: Partial<ScanWorktreesDeps> = {}): Promise<WorktreeInfo[]> {
  const d = scanDeps(deps);
  const reposRoot = join(d.getGhqRoot(), "github.com");
  const fleetDirs = uniqueDirs(d.fleetDirs?.length ? d.fleetDirs : [d.fleetDir]);

  // 1. Find all legacy .wt-* and nested agents/* worktree directories
  // #1553 — dedupe paths; `find` can surface the same .wt-* dir multiple times
  // when nested ghq layouts walk through symlinks or overlapping prefixes,
  // turning N worktrees into N×K classification rows + ambiguity error spam.
  let wtPaths: string[] = [];
  try {
    const raw = await d.hostExec(`find ${reposRoot} -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`);
    wtPaths = [...new Set(raw.split("\n").filter(Boolean))];
  } catch { /* no worktrees */ }

  // 2. Get running tmux windows for matching
  // listSessions() can throw if tmux is down or SSH fails — treat as empty
  // (all worktrees will classify as stale, which is correct: no windows running).
  let sessions: Session[] = [];
  try {
    sessions = await d.listSessions();
  } catch { /* tmux unavailable — proceed with no running windows */ }
  const runningWindows = new Set<string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      runningWindows.add(w.name);
    }
  }

  // 3. Load fleet configs for matching
  const fleetWindows = new Map<string, string>(); // repo -> fleet file
  const seenFleetFiles = new Set<string>();
  for (const fleetDir of fleetDirs) {
    try {
      for (const file of d.readdirSync(fleetDir).filter(f => f.endsWith(".json")).sort()) {
        if (seenFleetFiles.has(file)) continue;
        seenFleetFiles.add(file);
        try {
          const cfg = JSON.parse(d.readFileSync(join(fleetDir, file), "utf-8"));
          for (const w of cfg.windows || []) {
            // Fleet dirs are ordered by precedence (XDG state before legacy).
            // Keep the first source that mentions a repo so lower-precedence
            // legacy configs cannot shadow migrated state.
            if (w.repo && !fleetWindows.has(w.repo)) fleetWindows.set(w.repo, file);
          }
        } catch { /* invalid fleet file */ }
      }
    } catch { /* no fleet dir */ }
  }

  // 4. Classify each worktree
  const results: WorktreeInfo[] = [];

  for (const wtPath of wtPaths) {
    const parsed = parseWorktreePath(wtPath, reposRoot);
    if (!parsed) continue;
    const { dirName, mainRepoName, wtName, mainRepo, repo } = parsed;

    // Get branch
    let branch = "";
    try {
      branch = (await d.hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD 2>/dev/null`)).trim();
    } catch { branch = "unknown"; }

    // Match to tmux window — check fleet config or name pattern.
    // The matching policy is pure and fixture-backed in worktree-window-match
    // (#823/#935/#1553/#1612); scanWorktrees owns only IO and rendering.
    let tmuxWindow: string | undefined;
    const fleetFile = fleetWindows.get(repo);
    const windowMatch = resolveWorktreeWindow(mainRepoName, wtName, sessions);
    switch (windowMatch.kind) {
      case "bound":
        tmuxWindow = windowMatch.window;
        break;
      case "ambiguous":
        d.error(`  \x1b[31m✗\x1b[0m '${windowMatch.query}' is ambiguous — matches ${windowMatch.candidates.length} windows:`);
        for (const c of windowMatch.candidates) {
          d.error(`  \x1b[90m    • ${c}\x1b[0m`);
        }
        d.error(`  \x1b[90m  leaving worktree ${wtName} unbound (status: stale)\x1b[0m`);
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
      const prunable = await d.hostExec(`git -C '${mainPath}' worktree list --porcelain 2>/dev/null | grep -A1 'prunable' | grep 'worktree' | sed 's/worktree //'`);
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
