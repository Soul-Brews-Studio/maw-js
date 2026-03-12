import { ssh } from "./ssh";
import { resolveOracle, findWorktrees } from "./wake";
import { buildCommand } from "./config";

export async function cmdSpawn(oracle: string, opts: { name?: string; continue?: boolean }) {
  const { repoPath, repoName, parentDir } = await resolveOracle(oracle);

  const worktrees = await findWorktrees(parentDir, repoName);

  const sessionName = opts.name || `${oracle}`;

  // Check if session exists
  try {
    await ssh(`tmux has-session -t '${sessionName}' 2>/dev/null`);
    console.log(`\x1b[33msession already exists:\x1b[0m ${sessionName}`);
    console.log(`  attach: tmux attach -t ${sessionName}`);
    return;
  } catch { /* session doesn't exist — good */ }

  // Create session with main repo as first window
  await ssh(`tmux new-session -d -s '${sessionName}' -n '${oracle}-oracle' -c '${repoPath}'`);
  console.log(`\x1b[32m+\x1b[0m ${oracle} → ${repoPath}`);

  // Add worktree windows
  for (const wt of worktrees) {
    const winName = `${oracle}-${wt.name}`;
    await ssh(`tmux new-window -a -t '${sessionName}' -n '${winName}' -c '${wt.path}'`);
    console.log(`\x1b[32m+\x1b[0m ${winName} → ${wt.path}`);
  }

  // Optionally start claude --continue in all windows
  if (opts.continue) {
    const winList = await ssh(`tmux list-windows -t '${sessionName}' -F '#{window_index}'`);
    for (const idx of winList.split("\n").filter(Boolean)) {
      await ssh(`tmux send-keys -t '${sessionName}:${idx}' '${buildCommand(oracle + "-oracle")}' Enter`);
    }
    console.log(`\x1b[36mall waking with --continue\x1b[0m`);
  }

  await ssh(`tmux select-window -t '${sessionName}:{start}'`);
  console.log(`\n\x1b[36mspawned:\x1b[0m ${sessionName} (${1 + worktrees.length} windows)`);
  console.log(`  attach: tmux attach -t ${sessionName}`);
}
