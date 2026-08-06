import { statSync } from "fs";
import { isAbsolute, join, relative } from "path/posix";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { hostExec, tmux, type TmuxPane } from "maw-js/sdk";
import { parseWorktreePath } from "../../../../core/fleet/worktree-layout";

export type CleanupWorktreeClass = "KEEP" | "CLEAN" | "ASK" | "SKIP";

export interface CleanupWorktreeRow {
  path: string;
  repo: string;
  mainRepo: string;
  mainPath: string;
  name: string;
  branch: string;
  classification: CleanupWorktreeClass;
  reason: string;
  livePane?: string;
  removed?: boolean;
  error?: string;
}

export interface CleanupWorktreesDeps {
  hostExec: (command: string) => Promise<string>;
  listPanes: () => Promise<TmuxPane[]>;
  getGhqRoot: () => string;
  statSync: typeof statSync;
  getUid: () => number | undefined;
  getCwd: () => string;
}

export interface CleanupWorktreesOpts {
  yes?: boolean;
  json?: boolean;
  repo?: string;
  scope?: string;
  deps?: Partial<CleanupWorktreesDeps>;
}

function deps(overrides: Partial<CleanupWorktreesDeps> = {}): CleanupWorktreesDeps {
  return {
    hostExec: overrides.hostExec ?? hostExec,
    listPanes: overrides.listPanes ?? (() => tmux.listPanes()),
    getGhqRoot: overrides.getGhqRoot ?? getGhqRoot,
    statSync: overrides.statSync ?? statSync,
    getUid: overrides.getUid ?? (() => process.getuid?.()),
    getCwd: overrides.getCwd ?? (() => process.cwd()),
  };
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pathIsInside(base: string, child: string): boolean {
  const rel = relative(base, child);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

async function findCandidatePaths(d: CleanupWorktreesDeps, reposRoot: string): Promise<string[]> {
  try {
    const raw = await d.hostExec(
      `find ${shellArg(reposRoot)} -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`,
    );
    return [...new Set(raw.split("\n").map(s => s.trim()).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function normalizeRepoFilter(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return value.replace(/\/+$/g, "");
}

function isRepoMatch(mainRepo: string, rawFilter: string | undefined): boolean {
  const filter = normalizeRepoFilter(rawFilter);
  if (!filter) return true;
  if (mainRepo === filter) return true;
  if (!filter.includes("/")) return mainRepo.split("/").at(-1) === filter;
  return false;
}

function resolveScopeMainPath(reposRoot: string, scope: string | undefined, cwd: string): string | undefined {
  if (scope !== ".") return undefined;
  const rel = relative(reposRoot, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;

  const parts = rel.split("/");
  if (parts.length < 2) return undefined;

  const org = parts[0]!;
  const repo = parts[1]!.includes(".wt-") ? parts[1]!.split(".wt-")[0] : parts[1]!;
  return join(reposRoot, org, repo);
}

function shouldKeepRow(
  d: CleanupWorktreesDeps,
  reposRoot: string,
  opts: CleanupWorktreesOpts,
  row: CleanupWorktreeRow,
): boolean {
  if (!isRepoMatch(row.mainRepo, opts.repo)) return false;
  const scopeMainPath = resolveScopeMainPath(reposRoot, opts.scope, d.getCwd());
  if (opts.scope === "." && !scopeMainPath) return false;
  if (!scopeMainPath) return true;
  return row.mainPath === scopeMainPath;
}

async function hasUnpushedCommits(
  d: CleanupWorktreesDeps,
  wtPath: string,
  branch: string,
): Promise<boolean | "unknown"> {
  if (!branch || branch === "HEAD" || branch === "unknown") return "unknown";
  const upstream = `origin/${branch}`;
  try {
    await d.hostExec(`git -C ${shellArg(wtPath)} rev-parse --verify --quiet ${shellArg(upstream)}`);
  } catch {
    return true;
  }
  try {
    const count = Number((await d.hostExec(
      `git -C ${shellArg(wtPath)} rev-list --count ${shellArg(`${upstream}..HEAD`)}`,
    )).trim() || "0");
    return count > 0;
  } catch {
    return "unknown";
  }
}

async function classifyPath(
  d: CleanupWorktreesDeps,
  reposRoot: string,
  opts: CleanupWorktreesOpts,
  path: string,
  livePanes: TmuxPane[],
): Promise<CleanupWorktreeRow | null> {
  const parsed = parseWorktreePath(path, reposRoot);
  if (!parsed) return null;

  const base = {
    path,
    repo: parsed.repo,
    mainRepo: parsed.mainRepo,
    mainPath: parsed.mainPath,
    name: parsed.wtName,
  };

  if (!shouldKeepRow(d, reposRoot, opts, { ...base, branch: "", classification: "ASK", reason: "" })) {
    return null;
  }

  try {
    const owner = d.statSync(path).uid;
    const uid = d.getUid();
    if (uid !== undefined && owner !== uid) {
      return { ...base, branch: "", classification: "SKIP", reason: `owned by uid ${owner}` };
    }
  } catch (e: any) {
    return { ...base, branch: "", classification: "ASK", reason: `stat failed: ${e?.message || e}` };
  }

  const livePane = livePanes.find(p => p.cwd && pathIsInside(path, p.cwd));
  if (livePane) {
    return {
      ...base,
      branch: "",
      classification: "KEEP",
      reason: "live pane cwd is inside worktree",
      livePane: livePane.target || livePane.id,
    };
  }

  let branch = "";
  try {
    branch = (await d.hostExec(`git -C ${shellArg(path)} rev-parse --abbrev-ref HEAD`)).trim();
  } catch {
    return { ...base, branch: "", classification: "ASK", reason: "not a git worktree" };
  }

  try {
    const status = await d.hostExec(`git -C ${shellArg(path)} status --porcelain`);
    if (status.trim()) {
      return { ...base, branch, classification: "ASK", reason: "uncommitted changes" };
    }
  } catch (e: any) {
    return { ...base, branch, classification: "ASK", reason: `git status failed: ${e?.message || e}` };
  }

  const unpushed = await hasUnpushedCommits(d, path, branch);
  if (unpushed === true) return { ...base, branch, classification: "ASK", reason: "unpushed commits" };
  if (unpushed === "unknown") return { ...base, branch, classification: "ASK", reason: "upstream unknown" };

  return { ...base, branch, classification: "CLEAN", reason: "no live pane, clean git state" };
}

export async function surveyCleanupWorktrees(opts: CleanupWorktreesOpts = {}): Promise<CleanupWorktreeRow[]> {
  const d = deps(opts.deps);
  const reposRoot = join(d.getGhqRoot(), "github.com");
  const [paths, panes] = await Promise.all([
    findCandidatePaths(d, reposRoot),
    d.listPanes().catch(() => []),
  ]);
  const rows = await Promise.all(paths.map(p => classifyPath(d, reposRoot, opts, p, panes)));
  return rows.filter((row): row is CleanupWorktreeRow => row !== null);
}

export async function cmdCleanupWorktrees(opts: CleanupWorktreesOpts = {}): Promise<CleanupWorktreeRow[]> {
  const d = deps(opts.deps);
  const rows = await surveyCleanupWorktrees({ ...opts, deps: d });

  if (!opts.json) {
    console.log("\x1b[36mmaw cleanup --worktrees\x1b[0m — orphan worktree survey");
    if (rows.length === 0) console.log("  \x1b[32m✓\x1b[0m no agent worktrees found");
    for (const row of rows) {
      const branch = row.branch || "-";
      const live = row.livePane ? ` live=${row.livePane}` : "";
      console.log(
        `  ${row.classification.padEnd(5)} ${row.name.padEnd(24)} ${branch.padEnd(24)} ${row.reason}${live}`,
      );
      console.log(`        \x1b[90m${row.path}\x1b[0m`);
    }
  }

  if (!opts.yes) {
    if (!opts.json) console.log("\nDry-run only. Run with \x1b[36m--yes\x1b[0m to remove CLEAN worktrees.");
    return rows;
  }

  for (const row of rows.filter(r => r.classification === "CLEAN")) {
    try {
      await d.hostExec(`git -C ${shellArg(row.mainPath)} worktree remove ${shellArg(row.path)} --force`);
      await d.hostExec(`git -C ${shellArg(row.mainPath)} worktree prune`);
      row.removed = true;
      if (!opts.json) console.log(`  \x1b[32m✓\x1b[0m removed ${row.repo}`);
    } catch (e: any) {
      row.error = e?.message || String(e);
      if (!opts.json) console.log(`  \x1b[33m⚠\x1b[0m remove failed for ${row.repo}: ${row.error}`);
    }
  }

  return rows;
}
