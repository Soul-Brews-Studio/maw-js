import { hostExec, tmux } from "../../sdk";
import { buildCommand, buildCommandInDir, cfgTimeout } from "../../config";
import { execSync } from "child_process";

/** Attach to tmux session — switch-client if inside tmux, attach if fresh shell */
export async function attachToSession(session: string) {
  if (process.env.TMUX) {
    await tmux.switchClient(session);
  } else {
    execSync(`tmux attach-session -t ${session}`, { stdio: "inherit" });
  }
}

/**
 * Check whether a tmux pane's shell is idle (no child processes).
 * Returns true when the shell has no children → safe to retry.
 * Returns true on error as a fail-safe (preserves existing retry behavior).
 */
export async function isPaneIdle(paneTarget: string): Promise<boolean> {
  try {
    const panePid = (await hostExec(
      `tmux display-message -t '${paneTarget}' -p '#{pane_pid}'`
    )).trim();
    if (!panePid) return true;
    // pgrep -P shows direct children — if any, the shell is busy
    const children = (await hostExec(`pgrep -P ${panePid} 2>/dev/null || true`)).trim();
    return children.length === 0;
  } catch {
    return true; // fail-safe to current behavior
  }
}

export async function ensureSessionRunning(session: string, excludeNames?: Set<string>, cwdMap?: Record<string, string>): Promise<number> {
  let retried = 0;
  let windows: { index: number; name: string; active: boolean }[];
  try { windows = await tmux.listWindows(session); } catch { return 0; }

  const targets = windows.map(w => `${session}:${w.name}`);
  const cmds = await tmux.getPaneCommands(targets);

  for (const win of windows) {
    if (excludeNames?.has(win.name)) continue;
    const target = `${session}:${win.name}`;
    const paneCmd = (cmds[target] || "").trim().toLowerCase();
    if (paneCmd === "zsh" || paneCmd === "bash" || paneCmd === "sh" || paneCmd === "") {
      if (!(await isPaneIdle(target))) continue; // shell has children → mid-startup, skip
      try {
        await new Promise(r => setTimeout(r, cfgTimeout("wakeRetry")));
        const cwd = cwdMap?.[win.name];
        const cmd = cwd ? buildCommandInDir(win.name, cwd) : buildCommand(win.name);
        await tmux.sendText(target, cmd);
        console.log(`\x1b[33m↻\x1b[0m retry: ${win.name} (was ${paneCmd || "empty"})`);
        retried++;
      } catch { /* window may have been killed */ }
    }
  }
  return retried;
}

/**
 * Inject the gitignored symlinks a worktree needs but `git worktree add` can't
 * carry over:
 *
 *   .agent   — mirrors the main tree's `.agent` symlink (central agent memory).
 *   .secrets — links to the per-repo fleet secret store, when one exists at
 *              ~/.arra-oracle-v2/fleet-secrets/<repo>/ .
 *
 * Both paths are gitignored, so a fresh worktree never inherits them. For
 * `.secrets` this previously forced agents to reconstruct the file by hand in
 * every fresh worktree — and some values (e.g. a hosted DB password) cannot be
 * reconstructed from any API at all. The central store is the single source of
 * truth; worktrees just symlink to it. Onboarding another repo to this scheme
 * is purely a matter of populating `fleet-secrets/<repo>/` — no code change.
 *
 * Idempotent: each link is created only when the destination is absent, so this
 * is safe to call on worktree creation AND on every reuse/wake — a worktree
 * created before this was wired gets backfilled the next time it is woken.
 */
export async function injectWorktreeSymlinks(
  repoPath: string,
  wtPath: string,
  repoName: string,
): Promise<void> {
  const { lstatSync, statSync, readlinkSync, symlinkSync } = await import("fs");
  const { homedir } = await import("os");

  // .agent — mirror the main tree's symlink target verbatim.
  try {
    const agentSrc = `${repoPath}/.agent`;
    const agentDst = `${wtPath}/.agent`;
    if (
      lstatSync(agentSrc, { throwIfNoEntry: false })?.isSymbolicLink() &&
      !lstatSync(agentDst, { throwIfNoEntry: false })
    ) {
      symlinkSync(readlinkSync(agentSrc), agentDst);
      console.log(`\x1b[32m+\x1b[0m .agent symlink: ${agentDst}`);
    }
  } catch { /* non-fatal */ }

  // .secrets — link to the central per-repo fleet secret store, by convention.
  try {
    const storeDir = `${homedir()}/.arra-oracle-v2/fleet-secrets/${repoName}`;
    const secretsDst = `${wtPath}/.secrets`;
    if (
      statSync(storeDir, { throwIfNoEntry: false })?.isDirectory() &&
      !lstatSync(secretsDst, { throwIfNoEntry: false })
    ) {
      symlinkSync(storeDir, secretsDst);
      console.log(`\x1b[32m+\x1b[0m .secrets symlink: ${secretsDst} → ${storeDir}`);
    }
  } catch { /* non-fatal */ }
}

/**
 * Create a new git worktree for an oracle task.
 * Returns the worktree path and window name.
 */
export async function createWorktree(
  repoPath: string,
  parentDir: string,
  repoName: string,
  oracle: string,
  name: string,
  existingWorktrees: { name: string; path: string }[],
): Promise<{ wtPath: string; windowName: string }> {
  const nums = existingWorktrees.map(w => parseInt(w.name) || 0);
  const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const wtName = `${nextNum}-${name}`;
  const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
  const branch = `agents/${wtName}`;
  const safe = (s: string) => s.replace(/'/g, "'\\''");
  try { await hostExec(`git -C '${safe(repoPath)}' rev-parse HEAD 2>/dev/null`); } catch {
    await hostExec(`git -C '${safe(repoPath)}' commit --allow-empty -m "init: bootstrap for worktree"`);
  }
  try { await hostExec(`git -C '${safe(repoPath)}' branch -D '${safe(branch)}' 2>/dev/null`); } catch { /* ok */ }
  // Branch from origin/<default> (fresh) instead of primary worktree's HEAD —
  // primary often parks on a stale feature branch from a prior session, which
  // would otherwise propagate stale state to every new agent worktree. Fall
  // back to no starting-point (current HEAD) if origin/HEAD isn't configured.
  let baseRef = "";
  try {
    baseRef = await hostExec(`git -C '${safe(repoPath)}' symbolic-ref --short refs/remotes/origin/HEAD`);
  } catch { /* origin/HEAD not set — fall back to HEAD */ }
  if (baseRef) {
    try { await hostExec(`git -C '${safe(repoPath)}' fetch origin --quiet`); } catch { /* offline OK */ }
  }
  const baseArg = baseRef ? ` '${safe(baseRef)}'` : "";
  await hostExec(`git -C '${safe(repoPath)}' worktree add '${safe(wtPath)}' -b '${safe(branch)}'${baseArg}`);
  // Inject gitignored symlinks (.agent, .secrets) the fresh worktree can't inherit.
  await injectWorktreeSymlinks(repoPath, wtPath, repoName);
  console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);
  return { wtPath, windowName: `${oracle}-${name}` };
}
