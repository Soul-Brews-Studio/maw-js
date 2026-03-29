import { ssh } from "../ssh";
import { tmux } from "../tmux";
import { loadConfig, buildCommand, getEnvVars } from "../config";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../paths";
import { restoreTabOrder } from "../tab-order";

/**
 * Verify all windows in a session are running Claude (not empty zsh).
 * Retries buildCommand for any that are still on a shell prompt.
 */
export async function ensureSessionRunning(session: string): Promise<number> {
  let retried = 0;
  let windows: { index: number; name: string; active: boolean }[];
  try {
    windows = await tmux.listWindows(session);
  } catch { return 0; }

  const targets = windows.map(w => `${session}:${w.name}`);
  const cmds = await tmux.getPaneCommands(targets);

  for (const win of windows) {
    const target = `${session}:${win.name}`;
    const paneCmd = (cmds[target] || "").trim().toLowerCase();

    if (paneCmd === "zsh" || paneCmd === "bash" || paneCmd === "sh" || paneCmd === "") {
      try {
        await new Promise(r => setTimeout(r, 500));
        await tmux.sendText(target, buildCommand(win.name));
        console.log(`\x1b[33m↻\x1b[0m retry: ${win.name} (was ${paneCmd || "empty"})`);
        retried++;
      } catch { /* window may have been killed */ }
    }
  }
  return retried;
}

/** Fetch a GitHub issue and build a prompt for claude -p */
export async function fetchIssuePrompt(issueNum: number, repo?: string): Promise<string> {
  // Detect repo from git remote if not specified
  let repoSlug = repo;
  if (!repoSlug) {
    try {
      const remote = await ssh("git remote get-url origin 2>/dev/null");
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (m) repoSlug = m[1];
    } catch { /* expected: may not be in a git repo */ }
  }
  if (!repoSlug) throw new Error("Could not detect repo — pass --repo org/name");

  const json = await ssh(`gh issue view ${issueNum} --repo '${repoSlug}' --json title,body,labels`);
  const issue = JSON.parse(json);
  const labels = (issue.labels || []).map((l: any) => l.name).join(", ");
  const parts = [
    `Work on issue #${issueNum}: ${issue.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    issue.body || "(no description)",
  ];
  return parts.filter(Boolean).join("\n");
}

export async function resolveOracle(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  // 1. Try standard pattern: <oracle>-oracle
  const ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`);
  if (ghqOut?.trim()) {
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  }

  // 2. Fallback: check fleet configs for repo mapping
  const fleetDir = FLEET_DIR;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const win = (config.windows || []).find((w: any) => w.name === `${oracle}-oracle`);
      if (win?.repo) {
        const fullPath = await ssh(`ghq list --full-path | grep -i '/${win.repo.replace(/^[^/]+\//, "")}$' | head -1`);
        if (fullPath?.trim()) {
          const repoPath = fullPath.trim();
          const repoName = repoPath.split("/").pop()!;
          const parentDir = repoPath.replace(/\/[^/]+$/, "");
          return { repoPath, repoName, parentDir };
        }
      }
    }
  } catch { /* fleet dir may not exist */ }

  // 3. Federation fallback: check peers for the oracle
  try {
    const config = loadConfig();
    const peers = (config as any).peers || [];
    for (const peer of peers) {
      try {
        const res = await fetch(`${peer}/api/sessions`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const sessions = await res.json();
        const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];
        for (const s of list) {
          const oracleLower = oracle.toLowerCase();
          const sessionMatch = s.name.toLowerCase().includes(oracleLower);
          const found = (s.windows || []).find((w: any) =>
            w.name === `${oracle}-oracle` || w.name === oracle ||
            w.name.toLowerCase().startsWith(oracleLower)
          ) || (sessionMatch ? (s.windows || [])[0] : null);
          if (found) {
            console.log(`\x1b[36m⚡\x1b[0m ${oracle} found on peer ${peer} — waking remotely`);
            // Send wake command to peer
            await fetch(`${peer}/api/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: `${s.name}:${found.index}`, text: "" }),
            });
            console.log(`\x1b[32m✓\x1b[0m ${oracle} is running on ${peer} (session ${s.name}:${found.name})`);
            process.exit(0);
          }
        }
      } catch { /* peer unreachable */ }
    }
  } catch { /* no peers configured */ }

  console.error(`oracle repo not found: ${oracle} (tried local repos, fleet configs, and ${((loadConfig() as any).peers || []).length} peers)`);
  process.exit(1);
}

export async function findWorktrees(parentDir: string, repoName: string): Promise<{ path: string; name: string }[]> {
  const lsOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
  return lsOut.split("\n").filter(Boolean).map(p => {
    const base = p.split("/").pop()!;
    const suffix = base.replace(`${repoName}.wt-`, "");
    return { path: p, name: suffix };
  });
}

// Oracle → tmux session mapping (from config, with hardcoded fallback)
export function getSessionMap(): Record<string, string> {
  return loadConfig().sessions;
}

/** Scan fleet/*.json for a config containing a window matching the oracle name */
export function resolveFleetSession(oracle: string): string | null {
  const fleetDir = FLEET_DIR;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const hasOracleWindow = (config.windows || []).some(
        (w: any) => w.name === `${oracle}-oracle` || w.name === oracle
      );
      if (hasOracleWindow) return config.name;
    }
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function detectSession(oracle: string): Promise<string | null> {
  const sessions = await tmux.listSessions();

  // 1. Check manual session map
  const mapped = getSessionMap()[oracle];
  if (mapped) {
    const exists = sessions.find(s => s.name === mapped);
    if (exists) return mapped;
  }

  // 2. Pattern match running sessions (e.g., "08-neo" for oracle "neo")
  const patternMatch = sessions.find(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`))?.name
    || sessions.find(s => s.name === oracle)?.name;
  if (patternMatch) return patternMatch;

  // 3. Scan fleet configs for oracle → session name mapping
  const fleetSession = resolveFleetSession(oracle);
  if (fleetSession) {
    const exists = sessions.find(s => s.name === fleetSession);
    if (exists) return fleetSession;
  }

  return null;
}

/** Set config env vars on a tmux session (hidden from screen output) */
async function setSessionEnv(session: string): Promise<void> {
  for (const [key, val] of Object.entries(getEnvVars())) {
    await tmux.setEnvironment(session, key, val);
  }
}

function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._\-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]|[-.]$/g, "")
    .slice(0, 50);
}

export async function cmdWake(oracle: string, opts: { task?: string; newWt?: string; prompt?: string; incubate?: string }): Promise<string> {
  let resolved: { repoPath: string; repoName: string; parentDir: string };

  if (opts.incubate) {
    // Clone/update repo via ghq, then use it as the target
    const slug = opts.incubate; // e.g. "Soul-Brews-Studio/maw-js"
    const repoSlug = slug.includes("github.com") ? slug : `github.com/${slug}`;
    console.log(`\x1b[36m⚡\x1b[0m incubating ${slug}...`);
    await ssh(`ghq get -u -p ${repoSlug}`);
    const fullPath = await ssh(`ghq list --full-path | grep -i '${repoSlug}$' | head -1`);
    if (!fullPath?.trim()) throw new Error(`ghq could not find ${slug} after clone`);
    const repoPath = fullPath.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    resolved = { repoPath, repoName, parentDir };

    // Auto-derive task name from repo slug if not set
    if (!opts.task && !opts.newWt) {
      opts.newWt = repoName.replace(/-/g, "");
    }
  } else {
    resolved = await resolveOracle(oracle);
  }

  const { repoPath, repoName, parentDir } = resolved;

  // Detect or create tmux session (spawn all worktrees if new)
  let session = await detectSession(oracle);
  if (!session) {
    session = getSessionMap()[oracle] || resolveFleetSession(oracle) || oracle;
    // Create session with main window (use oracle-oracle name to match fleet configs)
    const mainWindowName = `${oracle}-oracle`;
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await setSessionEnv(session);
    await new Promise(r => setTimeout(r, 300));
    await tmux.sendText(`${session}:${mainWindowName}`, buildCommand(mainWindowName));
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${mainWindowName})`);

    // Spawn all existing worktree windows (strip number prefix from name)
    const allWt = await findWorktrees(parentDir, repoName);
    const usedNames = new Set<string>();
    for (const wt of allWt) {
      const taskPart = wt.name.replace(/^\d+-/, "");
      let wtWindowName = `${oracle}-${taskPart}`;
      if (usedNames.has(wtWindowName)) wtWindowName = `${oracle}-${wt.name}`; // collision fallback
      usedNames.add(wtWindowName);
      await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
      await new Promise(r => setTimeout(r, 300));
      await tmux.sendText(`${session}:${wtWindowName}`, buildCommand(wtWindowName));
      console.log(`\x1b[32m+\x1b[0m window: ${wtWindowName}`);
    }
  } else {
    // Ensure env vars are set on existing session (may predate this fix)
    await setSessionEnv(session);

    // Respawn missing worktree windows (e.g. after reboot)
    if (!opts.task && !opts.newWt) {
      const allWt = await findWorktrees(parentDir, repoName);
      if (allWt.length > 0) {
        let existingWindows: string[] = [];
        try {
          const windows = await tmux.listWindows(session);
          existingWindows = windows.map(w => w.name);
        } catch { /* ok */ }

        const usedNames = new Set(existingWindows);
        for (const wt of allWt) {
          const taskPart = wt.name.replace(/^\d+-/, "");
          let wtWindowName = `${oracle}-${taskPart}`;
          if (usedNames.has(wtWindowName)) wtWindowName = `${oracle}-${wt.name}`; // collision fallback
          // Also check old-style name with number
          const altName = `${oracle}-${wt.name}`;
          if (existingWindows.includes(wtWindowName) || existingWindows.includes(altName)) continue;

          usedNames.add(wtWindowName);
          await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
          await new Promise(r => setTimeout(r, 300));
          await tmux.sendText(`${session}:${wtWindowName}`, buildCommand(wtWindowName));
          console.log(`\x1b[32m↻\x1b[0m respawned: ${wtWindowName}`);
        }
      }
    }

    // Verify all windows started Claude (not stuck on zsh)
    await new Promise(r => setTimeout(r, 3000));
    const retried = await ensureSessionRunning(session);
    if (retried > 0) console.log(`\x1b[33m${retried} window(s) retried.\x1b[0m`);
  }

  // Restore saved tab order (from previous sleep)
  const reordered = await restoreTabOrder(session);
  if (reordered > 0) {
    console.log(`\x1b[36m↻ ${reordered} window(s) reordered to saved positions.\x1b[0m`);
  }

  let targetPath = repoPath;
  let windowName = `${oracle}-oracle`;

  if (opts.newWt || opts.task) {
    const rawName = opts.newWt || opts.task!;
    const name = sanitizeBranchName(rawName);
    const worktrees = await findWorktrees(parentDir, repoName);

    // Try to find existing worktree matching this name
    const match = worktrees.find(w => w.name.endsWith(`-${name}`) || w.name === name);

    if (match) {
      // Reuse existing worktree
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      // Create new worktree
      const nums = worktrees.map(w => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${name}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;

      // Delete stale branch if it exists but has no worktree (#62)
      const safeRepoPath = repoPath.replace(/'/g, "'\\''");
      const safeWtPath = wtPath.replace(/'/g, "'\\''");
      const safeBranch = branch.replace(/'/g, "'\\''");
      try { await ssh(`git -C '${safeRepoPath}' branch -D '${safeBranch}' 2>/dev/null`); } catch { /* branch doesn't exist — fine */ }
      await ssh(`git -C '${safeRepoPath}' worktree add '${safeWtPath}' -b '${safeBranch}'`);
      console.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch})`);

      targetPath = wtPath;
      windowName = `${oracle}-${name}`;
    }
  }

  // Check if window already exists (match exact name or fleet pattern oracle-N-name)
  try {
    const windows = await tmux.listWindows(session);
    const windowNames = windows.map(w => w.name);
    // Match exact name OR fleet config pattern (e.g. "pulse-scheduler" matches "pulse-1-scheduler")
    const nameSuffix = windowName.replace(`${oracle}-`, "");
    const existingWindow = windowNames.find(w => w === windowName)
      || windowNames.find(w => new RegExp(`^${oracle}-\\d+-${nameSuffix}$`).test(w));
    if (existingWindow) {
      if (opts.prompt) {
        // Window exists but we have a prompt → send claude -p
        console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' exists, sending prompt`);
        await tmux.selectWindow(`${session}:${existingWindow}`);
        const cmd = buildCommand(existingWindow);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        await tmux.sendText(`${session}:${existingWindow}`, `${cmd} -p '${escaped}'`);
        return `${session}:${existingWindow}`;
      }
      console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' already running in ${session}`);
      await tmux.selectWindow(`${session}:${existingWindow}`);
      return `${session}:${existingWindow}`;
    }
  } catch { /* session might be fresh */ }

  // Create window + start command (or with prompt)
  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  const cmd = buildCommand(windowName);
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await tmux.sendText(`${session}:${windowName}`, `${cmd} -p '${escaped}'`);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  return `${session}:${windowName}`;
}
