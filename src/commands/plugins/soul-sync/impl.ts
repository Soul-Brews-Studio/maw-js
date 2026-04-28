import { existsSync } from "fs";
import { join, basename } from "path";
import { hostExec } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
import { findPeers, findProjectsForOracle, syncOracleVaults, syncProjectVault, reportProjectResult, type SoulSyncResult, type ProjectSyncResult } from "./sync-helpers";
import { resolveOraclePath, resolveProjectSlug, findOracleForProject } from "./resolve";

export { syncDir, findPeers, findProjectsForOracle, syncProjectVault } from "./sync-helpers";
export type { SoulSyncResult, ProjectSyncResult } from "./sync-helpers";
export { resolveOraclePath, resolveProjectSlug, findOracleForProject } from "./resolve";

/**
 * maw soul-sync [peer] [--from <peer>] — push ψ/ to peers; --from reverses direction.
 * maw ss <peer>       push to specific peer
 * maw ss --from <p>   pull from specific peer
 */
export async function cmdSoulSync(target?: string, opts?: { from?: boolean; cwd?: string }): Promise<SoulSyncResult[]> {
  const results: SoulSyncResult[] = [];

  let cwd = opts?.cwd || "";
  if (!cwd) {
    try {
      cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
    } catch {
      cwd = process.cwd();
    }
  }

  const cwdParts = cwd.split("/");
  const repoName = cwdParts.pop() || "";
  // Strip `.wt-…` worktree suffix via indexOf — non-regex to avoid CodeQL polynomial-redos flag.
  const wtIdx = repoName.indexOf(".wt-");
  const baseRepo = wtIdx >= 0 ? repoName.slice(0, wtIdx) : repoName;
  const oracleName = baseRepo.replace(/-oracle$/, "");

  let oraclePath = cwd;
  try {
    const commonDir = (await hostExec(`git -C '${cwd}' rev-parse --git-common-dir`)).trim();
    if (commonDir && commonDir !== ".git") {
      const mainGit = commonDir.startsWith("/") ? commonDir : join(cwd, commonDir);
      oraclePath = join(mainGit, "..");
    }
  } catch { /* use cwd */ }

  const peers = target ? [target] : findPeers(oracleName);
  if (peers.length === 0) {
    console.log(`  \x1b[33m⚠\x1b[0m soul-sync: no sync_peers configured for '${oracleName}'`);
    console.log(`  \x1b[90mAdd "sync_peers": ["name"] to fleet config, or run: maw ss <peer>\x1b[0m`);
    return results;
  }

  const direction = opts?.from ? "pull" : "push";
  const label = direction === "pull"
    ? `pulling ${peers[0]} → ${oracleName}`
    : `pushing ${oracleName} → ${peers.join(", ")}`;
  console.log(`\n  \x1b[36m⚡ Soul Sync\x1b[0m — ${label}\n`);

  for (const peer of peers) {
    const peerPath = await resolveOraclePath(peer);
    if (!peerPath) {
      console.log(`  \x1b[33m⚠\x1b[0m ${peer}: repo not found, skipping`);
      continue;
    }

    const [from, to, fromName, toName] = direction === "pull"
      ? [peerPath, oraclePath, peer, oracleName]
      : [oraclePath, peerPath, oracleName, peer];

    const result = syncOracleVaults(from, to, fromName, toName);
    results.push(result);

    if (result.total === 0) {
      console.log(`  \x1b[90m○\x1b[0m ${fromName} → ${toName}: nothing new`);
    } else {
      const parts = Object.entries(result.synced).map(([dir, n]) => `${n} ${dir.split("/").pop()}`);
      console.log(`  \x1b[32m✓\x1b[0m ${fromName} → ${toName}: ${parts.join(", ")}`);
    }
  }

  const totalAll = results.reduce((a, r) => a + r.total, 0);
  if (totalAll > 0) {
    console.log(`\n  \x1b[32m${totalAll} file(s) synced.\x1b[0m\n`);
  } else {
    console.log();
  }

  return results;
}

/**
 * maw soul-sync --project — absorb project ψ/ into oracle ψ/ (inward only).
 * Oracle cwd: absorbs from each project_repos entry.
 * Project cwd: pushes ψ/ to the oracle that owns this repo.
 */
export async function cmdSoulSyncProject(opts?: { cwd?: string }): Promise<ProjectSyncResult[]> {
  const results: ProjectSyncResult[] = [];
  const reposRoot = join(getGhqRoot(), "github.com");

  let cwd = opts?.cwd || "";
  if (!cwd) {
    try {
      cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
    } catch {
      cwd = process.cwd();
    }
  }

  let repoRoot = cwd;
  try {
    const top = (await hostExec(`git -C '${cwd}' rev-parse --show-toplevel`)).trim();
    if (top) repoRoot = top;
  } catch { /* not a git repo */ }

  const repoSlug = resolveProjectSlug(repoRoot, reposRoot);
  const repoBase = basename(repoRoot).replace(/\.wt-.*$/, "");
  const isOracle = repoBase.endsWith("-oracle");

  console.log(`\n  \x1b[36m⚡ Soul Sync (project)\x1b[0m — ${isOracle ? "absorbing into" : "exporting from"} ${repoBase}\n`);

  if (isOracle) {
    const oracleName = repoBase.replace(/-oracle$/, "");
    const projects = findProjectsForOracle(oracleName);
    if (projects.length === 0) {
      console.log(`  \x1b[33m⚠\x1b[0m no project_repos configured for '${oracleName}'`);
      console.log(`  \x1b[90mAdd "project_repos": ["org/repo"] to fleet config for ${oracleName}.\x1b[0m\n`);
      return results;
    }
    for (const projectRepo of projects) {
      const projectPath = join(reposRoot, projectRepo);
      if (!existsSync(projectPath)) {
        console.log(`  \x1b[33m⚠\x1b[0m ${projectRepo}: not found at ${projectPath}, skipping`);
        continue;
      }
      const result = syncProjectVault(projectPath, repoRoot, projectRepo, oracleName);
      results.push(result);
      reportProjectResult(result);
    }
  } else {
    if (!repoSlug) {
      console.log(`  \x1b[33m⚠\x1b[0m cannot resolve project slug from ${repoRoot} (not under repos root ${reposRoot})\n`);
      return results;
    }
    const oracleName = findOracleForProject(repoSlug);
    if (!oracleName) {
      console.log(`  \x1b[33m⚠\x1b[0m no oracle owns project '${repoSlug}'`);
      console.log(`  \x1b[90mAdd "project_repos": ["${repoSlug}"] to an oracle's fleet config.\x1b[0m\n`);
      return results;
    }
    const oraclePath = await resolveOraclePath(oracleName);
    if (!oraclePath) {
      console.log(`  \x1b[33m⚠\x1b[0m oracle '${oracleName}' repo not found locally\n`);
      return results;
    }
    const result = syncProjectVault(repoRoot, oraclePath, repoSlug, oracleName);
    results.push(result);
    reportProjectResult(result);
  }

  const totalAll = results.reduce((a, r) => a + r.total, 0);
  if (totalAll > 0) {
    console.log(`\n  \x1b[32m${totalAll} file(s) absorbed.\x1b[0m\n`);
  } else {
    console.log();
  }
  return results;
}
