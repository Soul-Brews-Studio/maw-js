import { hostExec } from "../ssh";
import { tmux } from "../tmux";
import { buildCommand } from "../config";
import { findWorktrees } from "./wake";

async function resolveRepo(repo: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  // Support "org/repo" or bare "repo" — always search by last segment
  const searchTerm = repo.includes("/") ? repo.split("/").pop()! : repo;
  const ghqOut = await hostExec(`ghq list --full-path | grep -i '/${searchTerm}$' | head -1`);
  if (!ghqOut?.trim()) {
    console.error(`repo not found: ${repo}`);
    process.exit(1);
  }
  const repoPath = ghqOut.trim();
  const repoName = repoPath.split("/").pop()!;
  const parentDir = repoPath.replace(/\/[^/]+$/, "");
  return { repoPath, repoName, parentDir };
}

export async function cmdWorkon(repo: string, task?: string): Promise<void> {
  const { repoPath, repoName, parentDir } = await resolveRepo(repo);

  let targetPath = repoPath;
  let windowName = repoName;

  if (task) {
    const worktrees = await findWorktrees(parentDir, repoName);
    const match = worktrees.find(w => w.name.endsWith(`-${task}`) || w.name === task);

    if (match) {
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
    } else {
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${task}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;

      try { await hostExec(`git -C '${repoPath}' branch -D '${branch}' 2>/dev/null`); } catch { /* expected: branch may not exist */ }
      await hostExec(`git -C '${repoPath}' worktree add '${wtPath}' -b '${branch}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);
      targetPath = wtPath;
    }
    windowName = `${repoName}-${task}`;
  }

  // Detect current tmux session
  if (!process.env.TMUX) {
    console.error("not in a tmux session — run inside tmux");
    process.exit(1);
  }
  const session = (await hostExec("tmux display-message -p '#{session_name}'").catch(() => "")).trim();
  if (!session) {
    console.error("could not detect current tmux session");
    process.exit(1);
  }

  // Create window + start claude
  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  await tmux.sendText(`${session}:${windowName}`, buildCommand(windowName));

  console.log(`\x1b[32m✅\x1b[0m workon '${windowName}' in ${session} → ${targetPath}`);
}
