import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

/**
 * #19 — Detect stillborn git worktrees.
 *
 * A "stillborn worktree" is a `*.wt-*` directory with no live tmux window
 * AND no recent Claude session activity. Created via `maw wake --task` or
 * `maw workon` but never typed into.
 *
 * Across this fleet's history (today's survey): 113 of 152 wt-* project
 * dirs in ~/.claude/projects/ have ZERO sessions — pure tomb stones.
 *
 * Detection strategy (cheap, no manifest required):
 *   1. Find all `*-wt-*` dirs under ghq root
 *   2. Cross-reference with running tmux windows by name
 *   3. Classify:
 *        - active   — tmux window exists matching <stem>-<task>
 *        - stale    — on disk, no tmux window
 *
 * Stale worktrees are surfaced as warnings (ok:false) with
 * cleanup hints (`maw done <window>` reclaims them properly).
 *
 * Active-but-idle detection (≤1 message in N days) is deferred — requires
 * scanning .jsonl session files, which is heavier. This first cut focuses
 * on the cheap stale-detector.
 */
export function checkStillbornWorktrees(): {
  name: string;
  ok: boolean;
  message: string;
} {
  const ghqRoot = resolveGhqRoot();
  if (!ghqRoot) {
    return {
      name: "worktrees:stillborn",
      ok: true,
      message: "ghq root unavailable — skipping worktree scan",
    };
  }

  const wtDirs = findWorktreeDirs(ghqRoot);
  if (wtDirs.length === 0) {
    return {
      name: "worktrees:stillborn",
      ok: true,
      message: "no .wt-* directories found",
    };
  }

  const tmuxWindows = listAllTmuxWindowNames();

  const stillborn: string[] = [];
  const active: string[] = [];

  for (const wtPath of wtDirs) {
    const dirName = wtPath.split("/").pop()!;
    const parts = dirName.split(".wt-");
    if (parts.length < 2) continue;

    const mainStem = parts[0]!.replace(/-oracle$/, "");
    const wtName = parts[1]!.replace(/^\d+-/, ""); // strip leading "1-" → "awaken"

    // Window naming convention from createWorktree(): `${oracle}-${name}`
    // where oracle is typically the stem.
    const expectedWindow = `${mainStem}-${wtName}`;

    if (tmuxWindows.has(expectedWindow) || tmuxWindows.has(`${expectedWindow}-`)) {
      active.push(dirName);
    } else {
      stillborn.push(dirName);
    }
  }

  if (stillborn.length === 0) {
    return {
      name: "worktrees:stillborn",
      ok: true,
      message: `${active.length} active worktree${active.length === 1 ? "" : "s"}, 0 stillborn`,
    };
  }

  // Surface up to 5 examples, plus total count. Output via console for
  // human inspection (matches manifest:cross-source pattern).
  const sample = stillborn.slice(0, 5);
  for (const s of sample) {
    console.log(`    \x1b[33m⚠\x1b[0m stillborn: ${s} (cleanup: maw done ${stemToWindowName(s)})`);
  }
  if (stillborn.length > 5) {
    console.log(`    \x1b[90m... (+${stillborn.length - 5} more)\x1b[0m`);
  }

  return {
    name: "worktrees:stillborn",
    ok: false,
    message: `${stillborn.length} stillborn (no tmux window) | ${active.length} active`,
  };
}

/**
 * Map a worktree directory name to its expected tmux window name.
 * Mirrors the convention from `wake-session.ts:75-78`:
 *   wtPath = `${repoName}.wt-${nextNum}-${name}`
 *   windowName = `${oracle}-${name}`
 *
 * Where oracle is typically `repoName.replace(/-oracle$/, "")` (the stem).
 *
 * @example
 *   "discord-oracle.wt-1-awaken" → "discord-awaken"
 *   "neo-oracle.wt-3-feature-foo" → "neo-feature-foo"
 *   "myrepo.wt-1-task" → "myrepo-task"
 */
export function dirNameToWindowName(dirName: string): string {
  if (dirName.includes("/agents/")) {
    const wtName = basename(dirName).replace(/^\d+-/, "");
    const mainStem = basename(dirname(dirname(dirName))).replace(/-oracle$/, "");
    return `${mainStem}-${wtName}`;
  }
  const parts = dirName.split(".wt-");
  if (parts.length < 2) return dirName;
  const mainStem = parts[0]!.replace(/-oracle$/, "");
  const wtName = parts[1]!.replace(/^\d+-/, "");
  return `${mainStem}-${wtName}`;
}

const stemToWindowName = dirNameToWindowName;

function resolveGhqRoot(): string | null {
  try {
    const out = execSync("ghq root 2>/dev/null", { encoding: "utf-8" }).trim();
    return out || null;
  } catch {
    // Fallback: ~/Code (common convention)
    const fallback = join(homedir(), "Code");
    return existsSync(fallback) ? fallback : null;
  }
}

function findWorktreeDirs(ghqRoot: string): string[] {
  const githubBase = join(ghqRoot, "github.com");
  if (!existsSync(githubBase)) return [];

  const results: string[] = [];
  // Walk org dirs (max 2 levels: github.com/<org>/<repo>)
  let orgs: string[];
  try {
    orgs = readdirSync(githubBase);
  } catch {
    return [];
  }

  for (const org of orgs) {
    const orgDir = join(githubBase, org);
    let entries: string[];
    try {
      const s = statSync(orgDir);
      if (!s.isDirectory()) continue;
      entries = readdirSync(orgDir);
    } catch {
      continue;
    }

    for (const e of entries) {
      const fullPath = join(orgDir, e);
      try {
        if (e.includes(".wt-") && statSync(fullPath).isDirectory()) {
          results.push(fullPath);
          continue;
        }
        const agentsDir = join(fullPath, "agents");
        if (statSync(agentsDir).isDirectory()) {
          for (const wt of readdirSync(agentsDir)) {
            const nestedPath = join(agentsDir, wt);
            try {
              if (statSync(nestedPath).isDirectory()) results.push(nestedPath);
            } catch { /* skip nested */ }
          }
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

function listAllTmuxWindowNames(): Set<string> {
  const names = new Set<string>();
  try {
    const out = execSync(
      "tmux list-windows -a -F '#{window_name}' 2>/dev/null",
      { encoding: "utf-8" },
    );
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) names.add(trimmed);
    }
  } catch {
    // tmux unavailable — return empty set; classifier will mark all as stillborn
  }
  return names;
}
