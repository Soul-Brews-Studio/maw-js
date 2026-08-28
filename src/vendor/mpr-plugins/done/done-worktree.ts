import { realpathSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { parseWorktreePath, type ParsedWorktreePath } from "maw-js/core/fleet/worktree-layout";
import { doneDeps, doneFleetDirs, type DoneDeps, type ResolvedDoneDeps } from "./done-deps";

/** Resolve a path to its real, symlink-followed, normalized form. Falls back to
 *  a lexical resolve() when the path does not exist yet (still collapses `..`). */
function resolvedReal(p: string): string {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
}

/**
 * True only when `target` resolves to a path STRICTLY inside `root` (a proper
 * descendant, not root itself). Uses realpath (defeats symlink escape) and a
 * path-segment boundary via relative() — never a bare string prefix, so a
 * sibling like `<root>-evil` cannot pass. Guards `git worktree remove` against a
 * hostile/malformed fleet `win.worktree` that joins outside reposRoot yet still
 * parses as a legacy worktree. (Same containment class as orchestrator 13d8cd2.)
 */
export function isStrictlyInside(root: string, target: string): boolean {
  const r = resolvedReal(root);
  const t = resolvedReal(target);
  if (t === r) return false;
  const rel = relative(r, t);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface ContainedSlot {
  /** The joined path handed to `git worktree remove`. */
  fullPath: string;
  parsed: ParsedWorktreePath;
}

/**
 * Contain an attacker-controllable fleet `win.worktree`/`win.repo` value before
 * it reaches `git worktree remove`. Returns the resolved slot on success, or
 * `null` when the value must be refused.
 *
 * The tt3p layout symlinks each ghq repo dir (`<reposRoot>/<org>/<repo>`) to
 * `~/tt3p/product-hub/<repo>`, so a nested slot `<org>/<repo>/agents/<slot>`
 * realpath-resolves OUT of `<reposRoot>`. The old `isStrictlyInside(reposRoot,
 * fullPath)` gate then false-refused a LEGITIMATE slot (pilot #7). The fleet
 * JSON — not the ghq filesystem — is the attacker surface, so contain the slot
 * against its OWN repo anchor instead of the ghq root:
 *
 *   (a) lexical gate on the raw string: relative, no absolute, no `..` segment;
 *   (b) anchor = `join(reposRoot, org, repo)` from the target's first two
 *       segments; the parse must agree (`parsed.mainPath === anchor`), which
 *       bounds a nested slot to exactly `org/repo/agents/<slot>` — no injected
 *       depth can move the anchor;
 *   (c) re-root the slot suffix onto the repo's REAL path and require it to stay
 *       strictly inside — so the repo dir being a symlink (tt3p → product-hub)
 *       is accepted, but a symlink INSIDE the slot escaping the repo is rejected.
 *
 * Legacy `.wt-` worktrees are siblings of the repo dir under the real org dir.
 * The destructive target is the `.wt-` SLOT, so realpath-contain THAT under
 * reposRoot; the main repo dir may itself be a ghq→product-hub symlink, so
 * anchor it LEXICALLY (like the nested branch) rather than realpath-containing
 * it — otherwise a legit legacy sibling of a symlinked repo is false-refused.
 */
export function worktreeContainment(reposRoot: string, target: string): ContainedSlot | null {
  // (a) Lexical gate on the raw fleet string (the attacker surface).
  if (!target || isAbsolute(target)) return null;
  const segs = target.split(/[\\/]/).filter(Boolean);
  if (segs.length === 0 || segs.some(s => s === "..")) return null;

  const fullPath = join(reposRoot, target);
  const parsed = parseWorktreePath(fullPath, reposRoot);
  if (!parsed) return null;

  if (parsed.layout === "nested") {
    if (segs.length < 2) return null;
    // (b) Anchor from the first two segments; the parse must agree.
    const anchor = join(reposRoot, segs[0], segs[1]);
    if (parsed.mainPath !== anchor) return null;
    // (c) Re-root the slot onto the repo's REAL path before containing, so a
    // repo-level symlink (tt3p layout) is followed once and consistently while a
    // symlink inside the slot still shows up as an escape.
    const realAnchor = resolvedReal(anchor);
    const suffix = relative(anchor, fullPath);
    if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) return null;
    if (!isStrictlyInside(realAnchor, join(realAnchor, suffix))) return null;
    return { fullPath, parsed };
  }

  // Legacy `.wt-` sibling worktree. The destructive target is the `.wt-` SLOT
  // (fullPath) — a sibling of the repo dir under the real org dir — so contain
  // THAT under reposRoot by realpath (a slot that is itself a symlink escaping
  // the root is still rejected). The main repo dir (parsed.mainPath) may itself
  // be a ghq→product-hub symlink in the tt3p layout, so anchor it LEXICALLY —
  // exactly like the nested branch — instead of realpath-containing it and
  // false-refusing a legit sibling of a symlinked repo (Riddler, pilot #7).
  const org = segs.slice(0, -1).join("/");
  const anchor = join(reposRoot, org, parsed.mainRepoName);
  if (parsed.mainPath !== anchor) return null;
  if (!isStrictlyInside(reposRoot, fullPath)) return null;
  return { fullPath, parsed };
}

export interface DoneBranchCleanupOpts {
  cleanBranch?: boolean;
  /** Skip all branch cleanup — keep the branch even when merged (#2073 --keep-branch). */
  keepBranch?: boolean;
  branchBase?: string;
  dryRun?: boolean;
  cwd?: string;
  force?: boolean;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class DirtyWorktreeRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirtyWorktreeRemovalError";
  }
}

function isDirtyRemoveMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /modified or untracked|contains modified/i.test(message);
}

async function dirExists(path: string, d: ResolvedDoneDeps): Promise<boolean> {
  try {
    await d.hostExec(`test -d ${shellArg(path)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim an orphaned worktree directory left behind by a failed
 * `git worktree remove` (e.g. "not a working tree", "Directory not empty"):
 * verify it is clean, then delete it and prune the stale registration. A dirty
 * orphan is refused unless --force, so no uncommitted work is silently lost.
 * Returns true when the orphan was removed.
 */
async function removeFailedWorktreeDir(
  wtPath: string,
  mainPath: string,
  originalError: unknown,
  opts: DoneBranchCleanupOpts,
  d: ResolvedDoneDeps,
): Promise<boolean> {
  if (!(await dirExists(wtPath, d))) return false;

  let status = "";
  let statusKnown = false;
  try {
    status = await d.hostExec(`git -C ${shellArg(wtPath)} status --porcelain --untracked-files=all`);
    statusKnown = true;
  } catch (e: any) {
    if (!opts.force) {
      throw new DirtyWorktreeRemovalError(
        `worktree remove failed and ${wtPath} could not be checked for local changes (${e?.message || e}); rerun with --force to delete it`,
      );
    }
    d.logger.log(`  \x1b[33m⚠\x1b[0m deleting ${basename(wtPath)} with --force after status check failed: ${e?.message || e}`);
  }

  const dirty = status.trim().length > 0;
  if (dirty && !opts.force) {
    throw new DirtyWorktreeRemovalError(
      `worktree remove failed and ${wtPath} has uncommitted changes; rerun maw done --force to delete it`,
    );
  }

  try {
    await d.hostExec(`rm -rf ${shellArg(wtPath)}`);
    await d.hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
    const suffix = dirty
      ? " with --force despite uncommitted changes"
      : statusKnown
        ? " after verifying it was clean"
        : " with --force after status check failed";
    d.logger.log(`  \x1b[32m✓\x1b[0m removed orphan directory ${basename(wtPath)}${suffix}`);
    return true;
  } catch (e: any) {
    d.logger.log(`  \x1b[33m⚠\x1b[0m orphan directory removal failed after worktree remove failed (${e?.message || e}); original error: ${originalError instanceof Error ? originalError.message : originalError}`);
    return false;
  }
}

function activeFleetConfigFiles(d: ResolvedDoneDeps): Array<{ file: string; path: string }> {
  const filesByName = new Map<string, { file: string; path: string }>();
  let sawReadableDir = false;
  let lastError: unknown = null;
  for (const fleetDir of doneFleetDirs(d)) {
    let files: string[];
    try {
      files = d.fs.readdirSync(fleetDir).filter(f => f.endsWith(".json")).sort();
      sawReadableDir = true;
    } catch (error) {
      lastError = error;
      continue;
    }
    for (const file of files) {
      if (!filesByName.has(file)) filesByName.set(file, { file, path: join(fleetDir, file) });
    }
  }
  if (!sawReadableDir && lastError) throw lastError;
  return [...filesByName.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function windowMatchesWorktreeSuffix(windowName: string, wtName: string): boolean {
  const win = windowName.toLowerCase();
  // strip a leading numbered slot ("1-wt-foo" -> "wt-foo") so the worktree's own
  // slug is compared, not its slot index.
  const wtSuffix = wtName.replace(/^\d+-/, "").toLowerCase();
  if (!wtSuffix) return false;
  // A window is named "<oracle-or-session>-<wtName>". The oracle name may itself
  // contain hyphens (e.g. "pilot-hello-disposable"), so the old first-hyphen strip
  // broke the match. Match the worktree slug as the window's tail, bounded by a
  // hyphen so a suffix cannot substring-match a longer one ("wt-repro1" vs
  // "wt-repro11"). Genuine multi-matches are disambiguated by the caller.
  return win === wtSuffix || win.endsWith(`-${wtSuffix}`);
}

async function findMatchingWorktreePaths(windowName: string, reposRoot: string, d: ResolvedDoneDeps): Promise<string[]> {
  const ghqOut = await d.hostExec(`find ${shellArg(reposRoot)} -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`);
  const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
  return allWtPaths.filter(p => {
    const parsed = parseWorktreePath(p, reposRoot);
    if (!parsed) return false;
    return windowMatchesWorktreeSuffix(windowName, parsed.wtName);
  });
}

async function cwdMainPath(cwd: string | undefined, reposRoot: string, d: ResolvedDoneDeps): Promise<string | null> {
  if (!cwd) return null;
  try {
    const top = (await d.hostExec(`git -C ${shellArg(cwd)} rev-parse --show-toplevel`)).trim();
    if (!top) return null;
    const parsed = parseWorktreePath(top, reposRoot);
    return parsed?.mainPath ?? top;
  } catch {
    return null;
  }
}

function branchBaseFor(mainPath: string, d: ResolvedDoneDeps, opts: DoneBranchCleanupOpts = {}): string {
  if (opts.branchBase) return opts.branchBase;
  if (d.branchBase) return d.branchBase;
  const normalized = mainPath.split("\\").join("/");
  if (normalized.endsWith("/Soul-Brews-Studio/maw-js") || normalized.includes("/github.com/Soul-Brews-Studio/maw-js")) {
    return "alpha";
  }
  return "main";
}

function isProtectedBranch(branch: string, baseBranch: string): boolean {
  return branch === "HEAD" || branch === "main" || branch === "master" || branch === "alpha" || branch === baseBranch;
}

async function ghMergedPrExists(branch: string, d: ResolvedDoneDeps): Promise<"yes" | "no" | "unavailable"> {
  try {
    const out = await d.hostExec(`gh pr list --head ${shellArg(branch)} --state merged --json number --limit 1`);
    const parsed = JSON.parse(out || "[]");
    return Array.isArray(parsed) && parsed.length > 0 ? "yes" : "no";
  } catch {
    return "unavailable";
  }
}

export async function cleanupDoneBranch(
  mainPath: string,
  branch: string,
  opts: DoneBranchCleanupOpts = {},
  deps: DoneDeps = {},
): Promise<void> {
  const d = doneDeps(deps);
  if (opts.keepBranch) {
    if (branch) d.logger.log(`  \x1b[36m⬡\x1b[0m kept branch ${branch} (--keep-branch)`);
    return;
  }
  const baseBranch = branchBaseFor(mainPath, d, opts);
  if (!branch || isProtectedBranch(branch, baseBranch)) return;

  const quotedMain = shellArg(mainPath);
  const quotedBranch = shellArg(branch);
  if (opts.cleanBranch) {
    try {
      await d.hostExec(`git -C ${quotedMain} branch -D ${quotedBranch}`);
      d.logger.log(`  \x1b[32m✓\x1b[0m force-deleted branch ${branch}`);
    } catch (e: any) {
      d.logger.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): force delete failed: ${e?.message || e}`);
    }
    return;
  }

  try {
    await d.hostExec(`git -C ${quotedMain} merge-base --is-ancestor ${quotedBranch} ${shellArg(baseBranch)}`);
    await d.hostExec(`git -C ${quotedMain} branch -d ${quotedBranch}`);
    d.logger.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch} (merged into ${baseBranch})`);
    return;
  } catch {
    // Not an ancestor of the configured base, or local refs are unavailable.
  }

  const prState = await ghMergedPrExists(branch, d);
  if (prState === "yes") {
    try {
      await d.hostExec(`git -C ${quotedMain} branch -D ${quotedBranch}`);
      d.logger.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch} (merged PR)`);
    } catch (e: any) {
      d.logger.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): delete failed after merged PR proof: ${e?.message || e}`);
    }
    return;
  }

  if (prState === "unavailable") {
    d.logger.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): gh unavailable and not merged into ${baseBranch}`);
  } else {
    d.logger.log(`  \x1b[90m○\x1b[0m branch retained (${branch}): not merged into ${baseBranch} and no merged PR found`);
  }
}

/**
 * Remove a git worktree via fleet config lookup.
 * Returns true if a worktree was removed.
 */
export async function removeWorktreeViaConfig(
  windowNameLower: string,
  reposRoot: string,
  deps: DoneDeps = {},
  opts: DoneBranchCleanupOpts = {},
): Promise<boolean> {
  const d = doneDeps(deps);
  try {
    for (const { path } of activeFleetConfigFiles(d)) {
      let config: any;
      try {
        config = JSON.parse(d.fs.readFileSync(path, "utf-8"));
      } catch { continue; }
      const win = (config.windows || []).find((w: any) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo && !win?.worktree) continue;

      // Prefer the recorded worktree slot (org/repo/agents/N-slug). win.repo holds
      // only the BASE repo for a --work worker, so resolving win.repo would target
      // the main repo (parseWorktreePath → null → break) and leave the slot behind.
      // Legacy records without win.worktree fall through to the ghq scan below.
      const target: string = win.worktree ?? win.repo;
      // Containment gate: `win.worktree`/`win.repo` come from the fleet JSON and
      // are attacker-controllable. A value like `../../tmp/evil.wt-x` joins to a
      // path OUTSIDE reposRoot that parseWorktreePath's legacy branch still
      // accepts — never hand such a path to `git worktree remove`. A nested slot
      // is contained against its OWN repo anchor (the repo dir is legitimately a
      // ghq→product-hub symlink in the tt3p layout), so a real slot is accepted
      // while a symlink escaping the slot is still rejected. See worktreeContainment.
      const contained = worktreeContainment(reposRoot, target);
      if (!contained) {
        d.logger.error(`  \x1b[31m✗\x1b[0m refusing worktree outside repos root: ${target}`);
        break;
      }
      const { fullPath, parsed } = contained;
      const mainPath = parsed.mainPath;

      try {
        if (opts.dryRun) {
          d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${target}`);
          return true;
        }
        let branch = "";
        try { branch = (await d.hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        if (opts.force) {
          await d.hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(fullPath)} --force`);
        } else {
          await d.hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(fullPath)}`);
        }
        await d.hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
        d.logger.log(`  \x1b[32m✓\x1b[0m removed worktree ${target}`);
        await cleanupDoneBranch(mainPath, branch, opts, deps);
        return true;
      } catch (e: any) {
        // git itself reported uncommitted changes: refuse without --force (belt
        // and braces with the status check below; #2065/#2098). With --force we
        // already passed --force to git, so this branch only fires without it.
        if (isDirtyRemoveMessage(e) && !opts.force) {
          throw new DirtyWorktreeRemovalError(`worktree remove failed and ${fullPath} has uncommitted changes; rerun maw done --force to delete it`);
        }
        if (await removeFailedWorktreeDir(fullPath, mainPath, e, opts, d)) {
          return true;
        }
        d.logger.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e.message || e}`);
      }
      break;
    }
  } catch (e) {
    if (e instanceof DirtyWorktreeRemovalError) throw e;
    d.logger.error(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e}`);
  }
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
  deps: DoneDeps = {},
  opts: DoneBranchCleanupOpts = {},
): Promise<boolean> {
  const d = doneDeps(deps);
  let removed = false;
  try {
    const suffix = windowName.replace(/^[^-]+-/, ""); // e.g. "mother-schedule" → "schedule"
    const exactMatch = await findMatchingWorktreePaths(windowName, reposRoot, d);
    let matches = exactMatch;
    if (matches.length > 1) {
      const mainPath = await cwdMainPath(opts.cwd, reposRoot, d);
      if (mainPath) {
        const scoped = matches.filter((p) => parseWorktreePath(p, reposRoot)?.mainPath === mainPath);
        if (scoped.length === 1) {
          matches = scoped;
          d.logger.log(`  \x1b[36m⬡\x1b[0m scoped ambiguous worktree '${suffix}' to cwd repo ${mainPath}`);
        }
      }
    }
    if (matches.length > 1) {
      d.logger.error(`  \x1b[31m✗\x1b[0m refusing to remove worktree '${suffix}' — matches ${matches.length} repos:`);
      for (const wtPath of matches) d.logger.error(`  \x1b[90m    • ${wtPath}\x1b[0m`);
      d.logger.error(`  \x1b[90m  use fleet config or remove the exact worktree manually\x1b[0m`);
      return false;
    }
    for (const wtPath of matches) {
      const parsed = parseWorktreePath(wtPath, reposRoot);
      if (!parsed) continue;
      const base = parsed.dirName;
      const mainPath = parsed.mainPath;
      try {
        if (opts.dryRun) {
          d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${base}`);
          removed = true;
          continue;
        }
        let branch = "";
        try { branch = (await d.hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        if (opts.force) {
          await d.hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(wtPath)} --force`);
        } else {
          await d.hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(wtPath)}`);
        }
        await d.hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
        d.logger.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        await cleanupDoneBranch(mainPath, branch, opts, deps);
      } catch (e) {
        if (isDirtyRemoveMessage(e) && !opts.force) {
          throw new DirtyWorktreeRemovalError(`worktree remove failed and ${wtPath} has uncommitted changes; rerun maw done --force to delete it`);
        }
        if (await removeFailedWorktreeDir(wtPath, mainPath, e, opts, d)) {
          removed = true;
          continue;
        }
        d.logger.error(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e}`);
      }
    }
  } catch (e) {
    if (e instanceof DirtyWorktreeRemovalError) throw e;
    d.logger.error(`  \x1b[33m⚠\x1b[0m worktree scan failed: ${e}`);
  }
  return removed;
}

export async function warnRemainingWorktrees(windowName: string, reposRoot: string, deps: DoneDeps = {}): Promise<string[]> {
  const d = doneDeps(deps);
  let matches: string[] = [];
  try {
    matches = await findMatchingWorktreePaths(windowName, reposRoot, d);
  } catch (e: any) {
    d.logger.log(`  \x1b[33m⚠\x1b[0m cross-repo worktree scan failed: ${e?.message || e}`);
    return [];
  }
  if (matches.length === 0) return [];

  d.logger.log(`  \x1b[33m⚠\x1b[0m ${matches.length} same-member worktree(s) still exist in other repo(s):`);
  for (const match of matches) d.logger.log(`  \x1b[90m    • ${match}\x1b[0m`);
  d.logger.log(`  \x1b[90m  inspect them or run maw cleanup --worktrees before respawning\x1b[0m`);
  return matches;
}

/** Remove a window entry from all fleet config JSON files. Returns true if any file was updated. */
export function removeFromFleetConfig(windowNameLower: string, deps: DoneDeps = {}): boolean {
  const d = doneDeps(deps);
  let removed = false;
  try {
    for (const { file, path: filePath } of activeFleetConfigFiles(d)) {
      const config = JSON.parse(d.fs.readFileSync(filePath, "utf-8"));
      const before = config.windows?.length || 0;
      config.windows = (config.windows || []).filter((w: any) => w.name.toLowerCase() !== windowNameLower);
      if (config.windows.length < before) {
        d.fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
        d.logger.log(`  \x1b[32m✓\x1b[0m removed from ${file}`);
        removed = true;
      }
    }
  } catch { /* fleet dir may not exist */ }
  return removed;
}
