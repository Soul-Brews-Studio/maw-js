import { existsSync, readdirSync, copyFileSync, mkdirSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { hostExec } from "../ssh";
import { loadConfig } from "../config";
import { loadFleet, type FleetSession } from "./fleet-load";

const SYNC_DIRS = ["memory/learnings", "memory/retrospectives", "memory/traces"];

/**
 * Sync new files from src dir to dst dir (skip existing).
 * Returns count of files copied.
 */
export function syncDir(srcDir: string, dstDir: string): number {
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

/**
 * Resolve ghq path for an oracle name.
 * Tries: ghq list --full-path | grep -i '/<name>-oracle$'
 */
async function resolveOraclePath(name: string): Promise<string | null> {
  try {
    const out = await hostExec(`ghq list --full-path | grep -i '/${name}-oracle$' | head -1`);
    if (out?.trim()) return out.trim();
  } catch { /* not found */ }

  // Fallback: check fleet config for repo path
  const ghqRoot = loadConfig().ghqRoot;
  const fleet = loadFleet();
  for (const sess of fleet) {
    const oracleName = sess.name.replace(/^\d+-/, "");
    if (oracleName === name && sess.windows.length > 0) {
      const repoPath = join(ghqRoot, sess.windows[0].repo);
      if (existsSync(repoPath)) return repoPath;
    }
  }

  return null;
}

/**
 * Find peer oracle names for a given oracle from fleet config.
 * Flat lookup — each oracle declares its own sync_peers.
 */
export function findPeers(oracleName: string): string[] {
  const fleet = loadFleet();
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName && sess.sync_peers) return sess.sync_peers;
  }
  return [];
}

/**
 * Find project repos this oracle absorbs from.
 */
export function findProjectsForOracle(oracleName: string): string[] {
  const fleet = loadFleet();
  for (const sess of fleet) {
    const name = sess.name.replace(/^\d+-/, "");
    if (name === oracleName) return sess.project_repos || [];
  }
  return [];
}

/**
 * Find the oracle that owns a given project repo (org/repo slug).
 */
export function findOracleForProject(projectRepo: string): string | null {
  const fleet = loadFleet();
  for (const sess of fleet) {
    if (sess.project_repos?.includes(projectRepo)) {
      return sess.name.replace(/^\d+-/, "");
    }
  }
  return null;
}

export interface SoulSyncResult {
  from: string;
  to: string;
  synced: Record<string, number>;
  total: number;
}

/**
 * Sync ψ/memory/ from one oracle repo to another (new files only).
 */
function syncOracleVaults(fromPath: string, toPath: string, fromName: string, toName: string): SoulSyncResult {
  const fromVault = join(fromPath, "ψ");
  const toVault = join(toPath, "ψ");

  const synced: Record<string, number> = {};
  for (const subdir of SYNC_DIRS) {
    const src = join(fromVault, subdir);
    const dst = join(toVault, subdir);
    const count = syncDir(src, dst);
    if (count > 0) synced[subdir] = count;
  }

  const total = Object.values(synced).reduce((a, b) => a + b, 0);

  // Write sync receipt log
  if (total > 0) {
    const logDir = join(toVault, ".soul-sync");
    try {
      mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString();
      const logLine = `${ts} | ${fromName} → ${toName} | ${total} files | ${Object.entries(synced).map(([k, v]) => `${v} ${k.split("/").pop()}`).join(", ")}\n`;
      appendFileSync(join(logDir, "sync.log"), logLine);
    } catch { /* non-critical */ }
  }

  return { from: fromName, to: toName, synced, total };
}

/**
 * maw soul-sync [peer] [--from <peer>]
 *
 * Flat mycelium model — any oracle syncs to any peer.
 *
 *   maw ss              push to all configured sync_peers
 *   maw ss <peer>       push to specific peer
 *   maw ss --from <p>   pull from specific peer
 */
export async function cmdSoulSync(target?: string, opts?: { from?: boolean; cwd?: string }): Promise<SoulSyncResult[]> {
  const results: SoulSyncResult[] = [];

  // Resolve current oracle
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
  const oracleName = repoName.replace(/-oracle$/, "").replace(/\.wt-.*$/, "");

  // Resolve current oracle path (may be worktree, use git common dir)
  let oraclePath = cwd;
  try {
    const commonDir = (await hostExec(`git -C '${cwd}' rev-parse --git-common-dir`)).trim();
    if (commonDir && commonDir !== ".git") {
      const mainGit = commonDir.startsWith("/") ? commonDir : join(cwd, commonDir);
      oraclePath = join(mainGit, "..");
    }
  } catch { /* use cwd */ }

  // Determine peers to sync with
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

export interface ProjectSyncResult {
  project: string;
  oracle: string;
  synced: Record<string, number>;
  total: number;
}

/**
 * Sync ψ/memory/ from a project repo into an oracle repo.
 * Knowledge flows inward through the membrane — project → oracle, new files only.
 */
export function syncProjectVault(
  projectPath: string,
  oraclePath: string,
  projectRepo: string,
  oracleName: string,
): ProjectSyncResult {
  const projectVault = join(projectPath, "ψ");
  const oracleVault = join(oraclePath, "ψ");

  const synced: Record<string, number> = {};
  for (const subdir of SYNC_DIRS) {
    const src = join(projectVault, subdir);
    const dst = join(oracleVault, subdir);
    const count = syncDir(src, dst);
    if (count > 0) synced[subdir] = count;
  }
  const total = Object.values(synced).reduce((a, b) => a + b, 0);

  if (total > 0) {
    const logDir = join(oracleVault, ".soul-sync");
    try {
      mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString();
      const logLine = `${ts} | project:${projectRepo} → ${oracleName} | ${total} files | ${Object.entries(synced).map(([k, v]) => `${v} ${k.split("/").pop()}`).join(", ")}\n`;
      appendFileSync(join(logDir, "sync.log"), logLine);
    } catch { /* non-critical */ }
  }

  return { project: projectRepo, oracle: oracleName, synced, total };
}

function reportProjectResult(r: ProjectSyncResult) {
  if (r.total === 0) {
    console.log(`  \x1b[90m○\x1b[0m project:${r.project} → ${r.oracle}: nothing new`);
  } else {
    const parts = Object.entries(r.synced).map(([dir, n]) => `${n} ${dir.split("/").pop()}`);
    console.log(`  \x1b[32m✓\x1b[0m project:${r.project} → ${r.oracle}: ${parts.join(", ")}`);
  }
}

/**
 * maw soul-sync --project
 *
 * Cell membrane absorbing nutrients — project ψ/ flows INWARD into oracle ψ/.
 *
 * Resolution (auto-detect by cwd):
 *   - Inside an oracle repo (name ends `-oracle`): walk fleet's `project_repos`,
 *     pull each project's ψ/ → my ψ/.
 *   - Inside a project repo: find the oracle whose `project_repos` lists this
 *     repo, push my ψ/ → that oracle's ψ/.
 *
 * Always direction = INWARD (project → oracle). Knowledge cannot flow outward;
 * project repos are the environment, the oracle is the cell.
 */
export async function cmdSoulSyncProject(opts?: { cwd?: string }): Promise<ProjectSyncResult[]> {
  const results: ProjectSyncResult[] = [];
  const ghqRoot = loadConfig().ghqRoot;

  let cwd = opts?.cwd || "";
  if (!cwd) {
    try {
      cwd = (await hostExec("tmux display-message -p '#{pane_current_path}'")).trim();
    } catch {
      cwd = process.cwd();
    }
  }

  // Resolve git toplevel so we work even from a subdir
  let repoRoot = cwd;
  try {
    const top = (await hostExec(`git -C '${cwd}' rev-parse --show-toplevel`)).trim();
    if (top) repoRoot = top;
  } catch { /* not a git repo */ }

  // Strip ghq root → "org/repo" slug. Drop worktree suffix for matching.
  let repoSlug: string | null = null;
  if (repoRoot.startsWith(ghqRoot)) {
    const rel = repoRoot.slice(ghqRoot.length).replace(/^\/+/, "");
    const parts = rel.split("/").slice(0, 2);
    if (parts.length === 2) {
      parts[1] = parts[1].replace(/\.wt-.*$/, "");
      repoSlug = parts.join("/");
    }
  }

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
      const projectPath = join(ghqRoot, projectRepo);
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
      console.log(`  \x1b[33m⚠\x1b[0m cannot resolve project slug from ${repoRoot} (not under ghq root ${ghqRoot})\n`);
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
