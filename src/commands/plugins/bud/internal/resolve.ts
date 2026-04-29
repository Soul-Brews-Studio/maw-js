import { existsSync } from "fs";
import { join } from "path";
import { ghqFind } from "../../../../core/ghq";
import { getGhqRoot } from "../../../../config/ghq-root";
import { loadFleet } from "../../../shared/fleet-load";

/**
 * Resolve ghq path for an oracle name.
 * Tries: ghqFind(`/<stem>-oracle$`) — case-insensitive ghq lookup.
 *
 * Defensive — accepts both bare oracle name ("neo") and full repo name
 * ("neo-oracle"). Strips trailing "-oracle" before re-appending so callers
 * passing either form land on the same lookup. (#372)
 */
export async function resolveOraclePath(name: string): Promise<string | null> {
  // Strip trailing -oracle so "neo" and "neo-oracle" both resolve identically.
  const stem = name.replace(/-oracle$/, "");
  const out = await ghqFind(`/${stem}-oracle$`);
  if (out) return out;

  // Fallback: check fleet config for repo path
  const reposRoot = join(getGhqRoot(), "github.com");
  const fleet = loadFleet();
  for (const sess of fleet) {
    const oracleName = sess.name.replace(/^\d+-/, "");
    if (oracleName === stem && sess.windows.length > 0) {
      const repoPath = join(reposRoot, sess.windows[0].repo);
      if (existsSync(repoPath)) return repoPath;
    }
  }

  return null;
}

/**
 * Resolve a git repo path to its canonical "org/repo" slug for `project_repos`
 * lookup. Handles both shapes of `ghqRoot`:
 *
 *   A. github.com-rooted: `/home/neo/Code/github.com`
 *      repoRoot = `/home/neo/Code/github.com/Soul-Brews-Studio/maw-js`
 *      → rel = `Soul-Brews-Studio/maw-js` → slug = `Soul-Brews-Studio/maw-js`
 *
 *   B. bare ghq root:     `/home/neo/Code`
 *      repoRoot = `/home/neo/Code/github.com/Soul-Brews-Studio/maw-js`
 *      → rel = `github.com/Soul-Brews-Studio/maw-js` → (strip host) →
 *        `Soul-Brews-Studio/maw-js` → slug = `Soul-Brews-Studio/maw-js`
 *
 * Before this normalization, shape B produced the org-only slug
 * `github.com/Soul-Brews-Studio` because `.split("/").slice(0, 2)` grabbed
 * the host + org instead of org + repo. See #193.
 *
 * Worktree suffix (`.wt-*`) is stripped from the repo segment so worktrees
 * match their parent repo's `project_repos` entry.
 *
 * Returns null if `repoRoot` is not under `ghqRoot` or doesn't have the
 * expected depth (e.g. sitting directly under ghqRoot with no org segment).
 */
export function resolveProjectSlug(repoRoot: string, ghqRoot: string): string | null {
  if (!repoRoot.startsWith(ghqRoot)) return null;
  let rel = repoRoot.slice(ghqRoot.length).replace(/^\/+/, "");
  // If ghqRoot is the bare ghq root (not github.com-rooted), rel starts with
  // a host segment — strip known forges so we always land at "<org>/<repo>".
  rel = rel.replace(/^(github\.com|gitlab\.com|bitbucket\.org)\//, "");
  const parts = rel.split("/").slice(0, 2);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  parts[1] = parts[1].replace(/\.wt-.*$/, "");
  return parts.join("/");
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
