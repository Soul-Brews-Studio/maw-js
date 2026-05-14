/**
 * `maw worktree add/remove` — v1 (issue #1331).
 *
 * Mirrors `maw wake` for ARBITRARY code repos (mpr, sila, ad-hoc), where
 * raw `git worktree add` was previously used. Gives those workspaces the
 * same shape oracles already get: worktree + tmux window + engine spawn.
 *
 * Path scheme: `<parentDir>/<repoBasename>.wt-<slug>` (NOT `<repo>/agents/<slug>`)
 *   — sibling of the main repo, keeps existing `worktrees-scan.ts` and
 *   `done.ts` cleanup logic working.
 * Branch:      `feat/<slug>` from `--from` (default origin/alpha → origin/main).
 *
 * No registry in v1 — `git worktree list` is the source of truth.
 * Engine spawn is FREE: the per-window shell wrapper from `buildShellFunction`
 * launches whatever the user's `MAW_DEFAULT_ENGINE` is.
 *
 * Safety contract for `remove`:
 *   - refuses if `git status --porcelain` is non-empty UNLESS --allow-uncommitted
 *   - `git worktree remove --force` only with --allow-uncommitted
 */

import { existsSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { hostExec, tmux } from "../../sdk";
import { buildShellFunction } from "../../config";
import { attachToSession } from "./wake-session";
import { maybeSplit } from "./wake-maybe-split";
import { UserError } from "../../core/util/user-error";

export interface WorktreeAddOpts {
  from?: string;
  split?: boolean;
  noAttach?: boolean;
}

export interface WorktreeRemoveOpts {
  allowUncommitted?: boolean;
}

const safe = (s: string) => s.replace(/'/g, "'\\''");

function sanitizeSlug(slug: string): string {
  // Conservative: allow only [A-Za-z0-9._-]. Replace runs of other chars
  // with a single dash to keep filesystem + branch names clean.
  return slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await hostExec(`git -C '${safe(repoPath)}' rev-parse --verify '${safe(ref)}' 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

async function resolveFromRef(repoPath: string, requested?: string): Promise<string> {
  if (requested) {
    if (!(await refExists(repoPath, requested))) {
      console.error(`\x1b[31m✗\x1b[0m maw worktree add: --from ref not found: '${requested}'`);
      throw new UserError(`worktree add: bad --from ref`);
    }
    return requested;
  }
  // Default: origin/alpha → origin/main → main → HEAD
  for (const candidate of ["origin/alpha", "origin/main", "main", "HEAD"]) {
    if (await refExists(repoPath, candidate)) return candidate;
  }
  console.error(`\x1b[31m✗\x1b[0m maw worktree add: no usable base ref found in ${repoPath}`);
  throw new UserError(`worktree add: no base ref`);
}

export async function cmdWorktreeAdd(
  repoArg: string,
  slugArg: string,
  opts: WorktreeAddOpts,
): Promise<string> {
  if (!repoArg) { console.error("maw worktree add: missing <repo> argument"); throw new UserError("worktree add: missing repo"); }
  if (!slugArg) { console.error("maw worktree add: missing <slug> argument"); throw new UserError("worktree add: missing slug"); }

  const repoPath = resolve(repoArg);
  if (!existsSync(repoPath)) {
    console.error(`\x1b[31m✗\x1b[0m maw worktree add: repo path does not exist: ${repoPath}`);
    throw new UserError(`worktree add: repo missing`);
  }
  try {
    await hostExec(`git -C '${safe(repoPath)}' rev-parse --git-dir 2>/dev/null`);
  } catch {
    console.error(`\x1b[31m✗\x1b[0m maw worktree add: not a git repo: ${repoPath}`);
    throw new UserError(`worktree add: not a git repo`);
  }

  const slug = sanitizeSlug(slugArg);
  if (!slug) {
    console.error(`\x1b[31m✗\x1b[0m maw worktree add: slug sanitized to empty: '${slugArg}'`);
    throw new UserError(`worktree add: empty slug`);
  }

  const repoBasename = basename(repoPath);
  const parentDir = dirname(repoPath);
  const wtPath = join(parentDir, `${repoBasename}.wt-${slug}`);
  const branch = `feat/${slug}`;
  const fromRef = await resolveFromRef(repoPath, opts.from);

  if (existsSync(wtPath)) {
    console.error(`\x1b[31m✗\x1b[0m maw worktree add: worktree path already exists: ${wtPath}`);
    throw new UserError(`worktree add: path exists`);
  }

  console.log(`\x1b[36m⚡\x1b[0m creating worktree → ${wtPath}`);
  console.log(`\x1b[36m→\x1b[0m branch '${branch}' from '${fromRef}'`);

  // If a stale branch with this name exists (no worktree referencing it), drop
  // it so `worktree add -b` can recreate cleanly. Best-effort — git's own
  // safety prevents deleting branches in use.
  try {
    await hostExec(`git -C '${safe(repoPath)}' branch -D '${safe(branch)}' 2>/dev/null`);
  } catch { /* expected when no stale branch exists */ }

  await hostExec(
    `git -C '${safe(repoPath)}' worktree add '${safe(wtPath)}' -b '${safe(branch)}' '${safe(fromRef)}'`,
  );
  console.log(`\x1b[32m+\x1b[0m worktree created`);

  // Tmux: per-repo session named after repoBasename. Window name = slug.
  // Engine spawn is free via buildShellFunction (honors MAW_DEFAULT_ENGINE).
  const sessionName = repoBasename;
  const windowName = slug;
  const target = `${sessionName}:${windowName}`;

  let sessionExists = false;
  try { sessionExists = await tmux.hasSession(sessionName); } catch { /* tmux down */ }

  try {
    if (!sessionExists) {
      await tmux.newSession(sessionName, { window: windowName, cwd: wtPath });
      await new Promise(r => setTimeout(r, 300));
      await tmux.sendText(target, buildShellFunction(windowName));
      console.log(`\x1b[32m+\x1b[0m tmux session '${sessionName}' (window: ${windowName})`);
    } else {
      // Don't clobber an existing window with the same name in this session.
      let conflict = false;
      try {
        const windows = await tmux.listWindows(sessionName);
        conflict = windows.some(w => w.name === windowName);
      } catch { /* ok */ }
      if (conflict) {
        console.log(`\x1b[33m⚠\x1b[0m tmux window '${target}' already exists — leaving as-is`);
      } else {
        await tmux.newWindow(sessionName, windowName, { cwd: wtPath });
        await new Promise(r => setTimeout(r, 300));
        await tmux.sendText(target, buildShellFunction(windowName));
        console.log(`\x1b[32m+\x1b[0m tmux window '${target}'`);
      }
    }
  } catch (e: unknown) {
    // Tmux failure is non-fatal — the worktree itself is on disk.
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`\x1b[33m⚠\x1b[0m tmux setup failed (worktree still created): ${msg}`);
  }

  if (!opts.noAttach) {
    try { await attachToSession(sessionName); } catch { /* headless / no tty */ }
  }
  await maybeSplit(target, { split: opts.split });

  console.log(`\x1b[32m✅\x1b[0m worktree '${slug}' ready at ${wtPath}`);
  return target;
}

/**
 * Find the worktree path for a slug by scanning ghq for `*.wt-<slug>` dirs.
 * Returns null if not found; throws UserError on ambiguous matches.
 */
async function findWorktreePathBySlug(slug: string): Promise<string | null> {
  const { getGhqRoot } = await import("../../config/ghq-root");
  const reposRoot = join(getGhqRoot(), "github.com");
  let out = "";
  try {
    out = await hostExec(
      `find ${reposRoot} -maxdepth 4 -type d -name '*.wt-${safe(slug)}' 2>/dev/null`,
    );
  } catch { /* find returns non-zero on permission errors — treat as no match */ }
  const candidates = out.split("\n").map(s => s.trim()).filter(Boolean);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    console.error(
      `\x1b[31m✗\x1b[0m maw worktree remove: slug '${slug}' matches ${candidates.length} worktrees:\n` +
      candidates.map(c => `  ${c}`).join("\n") +
      `\n  use \`git worktree remove\` directly to disambiguate.`,
    );
    throw new UserError(`worktree remove: ambiguous slug`);
  }
  return candidates[0];
}

export async function cmdWorktreeRemove(
  slugArg: string,
  opts: WorktreeRemoveOpts,
): Promise<void> {
  if (!slugArg) {
    console.error("maw worktree remove: missing <slug> argument");
    throw new UserError("worktree remove: missing slug");
  }
  const slug = sanitizeSlug(slugArg);
  if (!slug) {
    console.error(`\x1b[31m✗\x1b[0m maw worktree remove: slug sanitized to empty: '${slugArg}'`);
    throw new UserError(`worktree remove: empty slug`);
  }

  const wtPath = await findWorktreePathBySlug(slug);
  if (!wtPath) {
    console.error(`\x1b[31m✗\x1b[0m maw worktree remove: no worktree found matching slug '${slug}'`);
    throw new UserError(`worktree remove: not found`);
  }

  const base = basename(wtPath);
  const mainRepoName = base.split(".wt-")[0];
  const mainPath = join(dirname(wtPath), mainRepoName);

  // Safety contract: refuse on dirty tree unless --allow-uncommitted.
  if (!opts.allowUncommitted) {
    let status = "";
    try {
      status = (await hostExec(`git -C '${safe(wtPath)}' status --porcelain 2>/dev/null`)).trim();
    } catch { /* if status fails, treat as clean — git worktree remove will catch real issues */ }
    if (status) {
      const lines = status.split("\n");
      const preview = lines.slice(0, 5).join("\n");
      const more = lines.length > 5 ? `\n      ... (${lines.length - 5} more)` : "";
      // UserError convention: print user-facing message at throw site;
      // top-level handler only uses the exception for the exit-1 contract.
      console.error(
        `\x1b[31m✗\x1b[0m maw worktree remove: '${slug}' has uncommitted changes:\n${preview}${more}\n` +
        `  re-run with --allow-uncommitted to force.`,
      );
      throw new UserError(`worktree remove: dirty tree (${slug})`);
    }
  }

  // Capture branch before removing the worktree (HEAD goes away after remove).
  let branch = "";
  try {
    branch = (await hostExec(`git -C '${safe(wtPath)}' rev-parse --abbrev-ref HEAD 2>/dev/null`)).trim();
  } catch { /* expected if worktree is detached */ }

  // Kill matching tmux window (best-effort). Session name = main repo basename.
  const sessionName = mainRepoName;
  const windowName = slug;
  try {
    await tmux.killWindow(`${sessionName}:${windowName}`);
    console.log(`\x1b[32m✓\x1b[0m killed tmux window ${sessionName}:${windowName}`);
  } catch { /* window may not exist; that's fine */ }

  const forceFlag = opts.allowUncommitted ? " --force" : "";
  await hostExec(
    `git -C '${safe(mainPath)}' worktree remove '${safe(wtPath)}'${forceFlag}`,
  );
  try { await hostExec(`git -C '${safe(mainPath)}' worktree prune`); } catch { /* harmless */ }
  console.log(`\x1b[32m✓\x1b[0m removed worktree ${wtPath}`);

  if (branch && branch !== "HEAD" && branch !== "main" && branch !== "master" && branch !== "alpha") {
    // Use safe delete unless --allow-uncommitted (which implies the user wants force).
    const branchDelFlag = opts.allowUncommitted ? "-D" : "-d";
    try {
      await hostExec(`git -C '${safe(mainPath)}' branch ${branchDelFlag} '${safe(branch)}'`);
      console.log(`\x1b[32m✓\x1b[0m deleted branch ${branch}`);
    } catch {
      console.log(`\x1b[33m⚠\x1b[0m branch '${branch}' not deleted (unmerged — use git branch -D manually)`);
    }
  }
}

/**
 * Dispatch entry for the `worktree` top-alias.
 * Routes `add` / `remove` (`rm`) subcommands.
 */
export async function cmdWorktree(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.error(
      "usage:\n" +
      "  maw worktree add <repo-path> <slug> [--from <ref>] [--split] [--no-attach]\n" +
      "  maw worktree remove <slug> [--allow-uncommitted]",
    );
    if (!sub) throw new UserError("worktree: missing subcommand");
    return;
  }

  const { parseFlags } = await import("../../cli/parse-args");

  if (sub === "add") {
    const flags = parseFlags(argv, {
      "--from": String,
      "--split": Boolean,
      "--no-attach": Boolean,
    }, 1);
    const positional = flags._;
    const repoArg = positional[0];
    const slugArg = positional[1];
    if (!repoArg || !slugArg) {
      console.error("usage: maw worktree add <repo-path> <slug> [--from <ref>] [--split] [--no-attach]");
      throw new UserError("worktree add: missing args");
    }
    await cmdWorktreeAdd(repoArg, slugArg, {
      from: flags["--from"],
      split: !!flags["--split"],
      noAttach: !!flags["--no-attach"],
    });
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const flags = parseFlags(argv, {
      "--allow-uncommitted": Boolean,
    }, 1);
    const positional = flags._;
    const slugArg = positional[0];
    if (!slugArg) {
      console.error("usage: maw worktree remove <slug> [--allow-uncommitted]");
      throw new UserError("worktree remove: missing slug");
    }
    await cmdWorktreeRemove(slugArg, {
      allowUncommitted: !!flags["--allow-uncommitted"],
    });
    return;
  }

  console.error(`maw worktree: unknown subcommand '${sub}' (expected: add | remove)`);
  throw new UserError(`worktree: unknown subcommand '${sub}'`);
}
