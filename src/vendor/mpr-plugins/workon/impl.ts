import { hostExec } from "maw-js/sdk";
import { tmux } from "maw-js/sdk";
import { ghqFind } from "maw-js/core/ghq";
import { buildCommand } from "maw-js/config";
import { findWorktrees } from "maw-js/commands/shared/wake";
import { resolveWorktreeTarget } from "maw-js/core/matcher/resolve-target";
import { normalizeWorktreeLayout, worktreePathForLayout, type WorktreeLayout } from "maw-js/core/fleet/worktree-layout";

async function resolveRepo(repo: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  // Support "org/repo" or bare "repo" — always search by last segment
  const searchTerm = repo.includes("/") ? repo.split("/").pop()! : repo;
  const repoPath = await ghqFind(`/${searchTerm}$`);
  if (!repoPath) {
    throw new Error(`repo not found: ${repo}`);
  }
  const repoName = repoPath.split("/").pop()!;
  const parentDir = repoPath.replace(/\/[^/]+$/, "");
  return { repoPath, repoName, parentDir };
}

export async function cmdWorkon(repo: string, task?: string, opts: { layout?: WorktreeLayout } = {}): Promise<void> {
  const { repoPath, repoName, parentDir } = await resolveRepo(repo);

  let targetPath = repoPath;
  let windowName = repoName;

  if (task) {
    const worktrees = await findWorktrees(parentDir, repoName);
    const resolved = resolveWorktreeTarget(task, worktrees);
    let match: { path: string; name: string } | null = null;
    switch (resolved.kind) {
      case "exact":
      case "fuzzy":
        match = resolved.match;
        break;
      case "ambiguous":
        console.error(`\x1b[31m✗\x1b[0m '${task}' is ambiguous — matches ${resolved.candidates.length} worktrees:`);
        for (const c of resolved.candidates) {
          console.error(`\x1b[90m    • ${c.name}\x1b[0m`);
        }
        console.error(`\x1b[90m  use the full name: maw workon ${repo} <exact-worktree>\x1b[0m`);
        throw new Error(`'${task}' is ambiguous — matches ${resolved.candidates.length} worktrees`);
      case "none":
        match = null;
        break;
    }

    if (match) {
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
    } else {
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${task}`;
      const layout = normalizeWorktreeLayout(opts.layout);
      const wtPath = worktreePathForLayout({ repoPath, parentDir, repoName, wtName, layout });
      const branch = `agents/${wtName}`;

      try { await hostExec(`git -C '${repoPath}' branch -D '${branch}' 2>/dev/null`); } catch { /* expected: branch may not exist */ }
      if (layout === "nested") await hostExec(`mkdir -p '${repoPath.replace(/'/g, "'\\''")}/agents'`);
      await hostExec(`git -C '${repoPath}' worktree add '${wtPath}' -b '${branch}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);
      targetPath = wtPath;
    }
    windowName = `${repoName}-${task}`;
  }

  // Detect current tmux session
  if (!process.env.TMUX) {
    throw new Error("not in a tmux session — run inside tmux");
  }
  const session = (await hostExec("tmux display-message -p '#{session_name}'").catch(() => "")).trim();
  if (!session) {
    throw new Error("could not detect current tmux session");
  }

  // Create window + start claude
  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  await tmux.sendText(`${session}:${windowName}`, buildCommand(windowName));

  console.log(`\x1b[32m✅\x1b[0m workon '${windowName}' in ${session} → ${targetPath}`);
}
