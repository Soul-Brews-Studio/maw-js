import { basename, dirname, join, relative } from "path";

export type WorktreeLayout = "nested" | "legacy";

export function normalizeWorktreeLayout(raw?: string): WorktreeLayout {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "nested") return "nested";
  if (value === "legacy") return "legacy";
  throw new Error(`invalid worktree layout '${raw}' — use 'nested' or 'legacy'`);
}

export function worktreePathForLayout(input: {
  repoPath: string;
  parentDir: string;
  repoName: string;
  wtName: string;
  layout?: WorktreeLayout;
}): string {
  const layout = input.layout ?? "nested";
  return layout === "legacy"
    ? join(input.parentDir, `${input.repoName}.wt-${input.wtName}`)
    : join(input.repoPath, "agents", input.wtName);
}

export function worktreeNameFromPath(path: string): string | null {
  const base = basename(path);
  if (dirname(path).endsWith("/agents")) return base;
  const marker = ".wt-";
  const index = base.indexOf(marker);
  if (index < 0) return null;
  return base.slice(index + marker.length);
}

export interface ParsedWorktreePath {
  layout: WorktreeLayout;
  path: string;
  dirName: string;
  mainRepoName: string;
  wtName: string;
  mainPath: string;
  mainRepo: string;
  repo: string;
}

export function parseWorktreePath(path: string, reposRoot: string): ParsedWorktreePath | null {
  const base = basename(path);
  const parent = dirname(path);

  if (basename(parent) === "agents") {
    const mainPath = dirname(parent);
    const mainRepoName = basename(mainPath);
    const mainRepo = relative(reposRoot, mainPath);
    if (!mainRepo || mainRepo.startsWith("..")) return null;
    const wtName = base;
    return {
      layout: "nested",
      path,
      dirName: `agents/${wtName}`,
      mainRepoName,
      wtName,
      mainPath,
      mainRepo,
      repo: `${mainRepo}/agents/${wtName}`,
    };
  }

  const marker = ".wt-";
  const index = base.indexOf(marker);
  if (index < 0) return null;
  const mainRepoName = base.slice(0, index);
  const wtName = base.slice(index + marker.length);
  const relPath = path.replace(reposRoot + "/", "");
  const parentParts = relPath.split("/");
  parentParts.pop();
  const org = parentParts.join("/");
  const mainRepo = `${org}/${mainRepoName}`;
  return {
    layout: "legacy",
    path,
    dirName: base,
    mainRepoName,
    wtName,
    mainPath: join(reposRoot, mainRepo),
    mainRepo,
    repo: `${org}/${base}`,
  };
}
