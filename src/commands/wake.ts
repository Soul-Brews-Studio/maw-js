import { hostExec } from "../ssh";
import { tmux } from "../tmux";
import { buildCommand, buildCommandInDir, cfgTimeout, loadConfig, saveConfig } from "../config";
import { restoreTabOrder } from "../tab-order";
import { takeSnapshot } from "../snapshot";
import { execSync } from "child_process";

/** Attach to tmux session — switch-client if inside tmux, attach if fresh shell */
async function attachToSession(session: string) {
  if (process.env.TMUX) {
    await tmux.switchClient(session);
  } else {
    execSync(`tmux attach-session -t ${session}`, { stdio: "inherit" });
  }
}
import {
  resolveOracle, findWorktrees, getSessionMap, resolveFleetSession,
  detectSession, setSessionEnv, sanitizeBranchName, fetchIssuePrompt,
} from "./wake-resolve";

// Re-export for external consumers
export { fetchIssuePrompt, findWorktrees, detectSession, resolveFleetSession };

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

export async function cmdWake(oracle: string, opts: { task?: string; newWt?: string; prompt?: string; incubate?: string; fresh?: boolean; noAttach?: boolean; listWt?: boolean }): Promise<string> {
  let resolved: { repoPath: string; repoName: string; parentDir: string };

  if (opts.incubate) {
    const slug = opts.incubate;
    const repoSlug = slug.includes("github.com") ? slug : `github.com/${slug}`;
    console.log(`\x1b[36m⚡\x1b[0m incubating ${slug}...`);
    await hostExec(`ghq get -u -p ${repoSlug}`);
    const fullPath = await hostExec(`ghq list --full-path | grep -i '${repoSlug}$' | head -1`);
    if (!fullPath?.trim()) throw new Error(`ghq could not find ${slug} after clone`);
    const repoPath = fullPath.trim();
    resolved = { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
    if (!opts.task && !opts.newWt) opts.newWt = resolved.repoName.replace(/-/g, "");
  } else {
    resolved = await resolveOracle(oracle);
  }

  const { repoPath, repoName, parentDir } = resolved;
  let session = await detectSession(oracle);

  if (!session) {
    session = getSessionMap()[oracle] || resolveFleetSession(oracle) || oracle;
    const mainWindowName = `${oracle}-oracle`;
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await setSessionEnv(session);
    await new Promise(r => setTimeout(r, 300));
    await tmux.sendText(`${session}:${mainWindowName}`, buildCommandInDir(mainWindowName, repoPath));
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${mainWindowName})`);

    // Auto-register agent in config.agents so federation peers can route to it (#285)
    const config = loadConfig();
    const agents = config.agents || {};
    if (!(oracle in agents)) {
      const node = config.node || "local";
      saveConfig({ agents: { ...agents, [oracle]: node } });
      console.log(`\x1b[32m+\x1b[0m registered agent '${oracle}' → '${node}' in config.agents`);
    }

    if (!opts.task && !opts.newWt) {
      const allWt = await findWorktrees(parentDir, repoName);
      const usedNames = new Set<string>();
      for (const wt of allWt) {
        const taskPart = wt.name.replace(/^\d+-/, "");
        let wtWindowName = `${oracle}-${taskPart}`;
        if (usedNames.has(wtWindowName)) wtWindowName = `${oracle}-${wt.name}`;
        usedNames.add(wtWindowName);
        await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
        await new Promise(r => setTimeout(r, 300));
        await tmux.sendText(`${session}:${wtWindowName}`, buildCommandInDir(wtWindowName, wt.path));
        console.log(`\x1b[32m+\x1b[0m window: ${wtWindowName}`);
      }
    }
  } else {
    await setSessionEnv(session);
    let preExistingWindows = new Set<string>();
    try { preExistingWindows = new Set((await tmux.listWindows(session)).map(w => w.name)); } catch { /* ok */ }

    if (!opts.task && !opts.newWt) {
      const allWt = await findWorktrees(parentDir, repoName);
      if (allWt.length > 0) {
        const existingWindows = [...preExistingWindows];
        const usedNames = new Set(existingWindows);
        for (const wt of allWt) {
          const taskPart = wt.name.replace(/^\d+-/, "");
          let wtWindowName = `${oracle}-${taskPart}`;
          if (usedNames.has(wtWindowName)) {
            if (existingWindows.includes(wtWindowName)) continue;
            wtWindowName = `${oracle}-${wt.name}`;
          }
          const altName = `${oracle}-${wt.name}`;
          if (existingWindows.includes(wtWindowName) || existingWindows.includes(altName)) continue;
          usedNames.add(wtWindowName);
          await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
          await new Promise(r => setTimeout(r, 300));
          await tmux.sendText(`${session}:${wtWindowName}`, buildCommandInDir(wtWindowName, wt.path));
          console.log(`\x1b[32m↻\x1b[0m respawned: ${wtWindowName}`);
        }
      }
    }

    await new Promise(r => setTimeout(r, cfgTimeout("wakeVerify")));
    const retried = await ensureSessionRunning(session, preExistingWindows);
    if (retried > 0) console.log(`\x1b[33m${retried} window(s) retried.\x1b[0m`);
  }

  const reordered = await restoreTabOrder(session);
  if (reordered > 0) console.log(`\x1b[36m↻ ${reordered} window(s) reordered to saved positions.\x1b[0m`);

  let targetPath = repoPath;
  let windowName = `${oracle}-oracle`;

  if (opts.listWt) {
    const worktrees = await findWorktrees(parentDir, repoName);
    if (!worktrees.length) { console.log(`\x1b[90mNo worktrees for ${oracle}.\x1b[0m`); }
    else {
      console.log(`\n\x1b[36mWorktrees for ${oracle}\x1b[0m (${worktrees.length})\n`);
      for (const wt of worktrees) console.log(`  \x1b[32m●\x1b[0m ${wt.name}  \x1b[90m${wt.path}\x1b[0m`);
    }
    return `${session}:${windowName}`;
  }

  if (opts.newWt || opts.task) {
    const name = sanitizeBranchName(opts.newWt || opts.task!);
    const worktrees = await findWorktrees(parentDir, repoName);
    const match = !opts.fresh ? worktrees.find(w => w.name.endsWith(`-${name}`) || w.name === name) : null;

    if (match) {
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${name}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;
      const safe = (s: string) => s.replace(/'/g, "'\\''");
      try { await hostExec(`git -C '${safe(repoPath)}' rev-parse HEAD 2>/dev/null`); } catch {
        await hostExec(`git -C '${safe(repoPath)}' commit --allow-empty -m "init: bootstrap for worktree"`);
      }
      try { await hostExec(`git -C '${safe(repoPath)}' branch -D '${safe(branch)}' 2>/dev/null`); } catch { /* ok */ }
      await hostExec(`git -C '${safe(repoPath)}' worktree add '${safe(wtPath)}' -b '${safe(branch)}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);
      targetPath = wtPath;
      windowName = `${oracle}-${name}`;
    }
  }

  try {
    const windows = await tmux.listWindows(session);
    const nameSuffix = windowName.replace(`${oracle}-`, "");
    const existingWindow = windows.map(w => w.name).find(w => w === windowName)
      || windows.map(w => w.name).find(w => new RegExp(`^${oracle}-\\d+-${nameSuffix}$`).test(w));
    if (existingWindow) {
      if (opts.prompt) {
        await tmux.selectWindow(`${session}:${existingWindow}`);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        await tmux.sendText(`${session}:${existingWindow}`, `${buildCommandInDir(existingWindow, targetPath)} -p '${escaped}'`);
        if (!opts.noAttach) await attachToSession(session);
        return `${session}:${existingWindow}`;
      }
      console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' already running in ${session}`);
      if (!opts.noAttach) {
        await tmux.selectWindow(`${session}:${existingWindow}`);
        await attachToSession(session);
      }
      return `${session}:${existingWindow}`;
    }
  } catch { /* session might be fresh */ }

  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  const cmd = buildCommandInDir(windowName, targetPath);
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await tmux.sendText(`${session}:${windowName}`, `${cmd} -p '${escaped}'`);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  if (!opts.noAttach) await attachToSession(session);
  takeSnapshot("wake").catch(() => {});
  return `${session}:${windowName}`;
}
