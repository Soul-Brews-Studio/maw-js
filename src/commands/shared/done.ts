import { join } from "path";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { listSessions, hostExec, tmux, FLEET_DIR, takeSnapshot } from "../../sdk";
import { getGhqRoot } from "../../config/ghq-root";
import { normalizeTarget } from "../../core/matcher/normalize-target";

export interface DoneOpts {
  force?: boolean;
  dryRun?: boolean;
}

type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };

export async function cmdDone(windowName_: string, opts: DoneOpts = {}) {
  let windowName = normalizeTarget(windowName_);
  const sessions = await listSessions();
  const reposRoot = join(getGhqRoot(), "github.com");

  const windowNameLower = windowName.toLowerCase();
  let sessionName: string | null = null;
  let windowIndex: number | null = null;
  for (const s of sessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; windowIndex = w.index; windowName = w.name; break; }
  }

  if (sessionName) {
    signalParentInbox(windowName, sessionName, sessions as SessionInfo[]);
  }

  if (sessionName !== null && windowIndex !== null && !opts.force) {
    await autoSave(windowName, sessionName, opts);
    if (opts.dryRun) return;
  } else if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] window '${windowName}' not running — nothing to auto-save`);
  }

  if (sessionName !== null && windowIndex !== null) {
    try {
      await tmux.killWindow(`${sessionName}:${windowName}`);
      console.log(`  \x1b[32m✓\x1b[0m killed window ${sessionName}:${windowName}`);
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m could not kill window (may already be closed)`);
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m window '${windowName}' not running`);
  }

  let removedWorktree = await removeWorktreeViaConfig(windowNameLower, reposRoot);
  if (!removedWorktree) {
    removedWorktree = await removeWorktreeByGhqScan(windowName, reposRoot);
  }
  if (!removedWorktree) {
    console.log(`  \x1b[90m○\x1b[0m no worktree to remove (may be a main window)`);
  }

  const removedFromConfig = removeFromFleetConfig(windowNameLower);
  if (!removedFromConfig) {
    console.log(`  \x1b[90m○\x1b[0m not in any fleet config`);
  }

  takeSnapshot("done").catch(() => {});
  console.log();
}

function signalParentInbox(
  windowName: string,
  sessionName: string,
  sessions: SessionInfo[],
): void {
  const from = process.env.CLAUDE_AGENT_NAME || windowName;
  const parentWindow = sessions.find(s => s.name === sessionName)?.windows[0]?.name;
  if (!parentWindow) return;
  const parentTarget = parentWindow.replace(/[^a-zA-Z0-9_-]/g, "");
  const inboxDir = join(homedir(), ".oracle", "inbox");
  const signal =
    JSON.stringify({ ts: new Date().toISOString(), from, type: "done", msg: `worktree ${windowName} completed`, thread: null }) + "\n";
  try {
    mkdirSync(inboxDir, { recursive: true });
    appendFileSync(join(inboxDir, `${parentTarget}.jsonl`), signal);
  } catch (e) {
    console.error(`  \x1b[33m⚠\x1b[0m inbox signal failed: ${e}`);
  }
}

async function autoSave(
  windowName: string,
  sessionName: string,
  opts: DoneOpts,
): Promise<void> {
  const target = `${sessionName}:${windowName}`;

  let paneCwd = "";
  try {
    paneCwd = (await hostExec(`tmux display-message -t '${target}' -p '#{pane_current_path}'`)).trim();
  } catch { /* pane may not exist */ }

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send /rrr to ${target} and wait 10s`);
    if (paneCwd) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would git add + commit + push in ${paneCwd}`);
    }
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would kill window ${target}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree + fleet config`);
    console.log();
    return;
  }

  console.log(`  \x1b[36m⏳\x1b[0m sending /rrr to ${target}...`);
  try {
    await tmux.sendText(target, "/rrr");
    await new Promise(r => setTimeout(r, 10_000));
    console.log(`  \x1b[32m✓\x1b[0m /rrr sent (waited 10s)`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m could not send /rrr (agent may not be running)`);
  }

  if (paneCwd) {
    console.log(`  \x1b[36m⏳\x1b[0m git auto-save in ${paneCwd}...`);
    try {
      await hostExec(`git -C '${paneCwd}' add -A`);
      try {
        await hostExec(`git -C '${paneCwd}' commit -m 'chore: auto-save before done'`);
        console.log(`  \x1b[32m✓\x1b[0m committed changes`);
      } catch {
        console.log(`  \x1b[90m○\x1b[0m nothing to commit`);
      }
      try {
        await hostExec(`git -C '${paneCwd}' push`);
        console.log(`  \x1b[32m✓\x1b[0m pushed to remote`);
      } catch {
        console.log(`  \x1b[33m⚠\x1b[0m push failed (no remote or auth issue)`);
      }
    } catch (e: unknown) {
      console.log(`  \x1b[33m⚠\x1b[0m git auto-save failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function removeWorktreeViaConfig(
  windowNameLower: string,
  reposRoot: string,
): Promise<boolean> {
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      const win = (config.windows || []).find((w: { name: string; repo?: string }) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo) continue;

      const fullPath = join(reposRoot, win.repo);
      if (!win.repo.includes(".wt-")) break;

      const parts = win.repo.split("/");
      const wtDir = parts.pop()!;
      const org = parts.join("/");
      const mainRepo = wtDir.split(".wt-")[0];
      const mainPath = join(reposRoot, org, mainRepo);

      try {
        let branch = "";
        try { branch = (await hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await hostExec(`git -C '${mainPath}' worktree remove '${fullPath}' --force`);
        await hostExec(`git -C '${mainPath}' worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${win.repo}`);
        if (branch && branch !== "main" && branch !== "HEAD") {
          try { await hostExec(`git -C '${mainPath}' branch -d '${branch}'`); console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch { /* expected */ }
        }
        return true;
      } catch (e: unknown) {
        console.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e instanceof Error ? e.message : e}`);
      }
      break;
    }
  } catch (e) { console.error(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e}`); }
  return false;
}

async function removeWorktreeByGhqScan(
  windowName: string,
  reposRoot: string,
): Promise<boolean> {
  let removed = false;
  try {
    const suffix = windowName.replace(/^[^-]+-/, "");
    const ghqOut = await hostExec(`find ${reposRoot} -maxdepth 3 -name '*.wt-*' -type d 2>/dev/null`);
    const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
    const exactMatch = allWtPaths.filter(p => {
      const base = p.split("/").pop()!;
      const wtSuffix = base.replace(/^.*\.wt-(?:\d+-)?/, "");
      return wtSuffix.toLowerCase() === suffix.toLowerCase();
    });
    for (const wtPath of exactMatch) {
      const base = wtPath.split("/").pop()!;
      const mainRepo = base.split(".wt-")[0];
      const mainPath = wtPath.replace(base, mainRepo);
      try {
        let branch = "";
        try { branch = (await hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await hostExec(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
        await hostExec(`git -C '${mainPath}' worktree prune`);
        console.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        if (branch && branch !== "main" && branch !== "HEAD") {
          try { await hostExec(`git -C '${mainPath}' branch -d '${branch}'`); console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch { /* expected */ }
        }
      } catch (e) { console.error(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e}`); }
    }
  } catch (e) { console.error(`  \x1b[33m⚠\x1b[0m worktree scan failed: ${e}`); }
  return removed;
}

function removeFromFleetConfig(windowNameLower: string): boolean {
  let removed = false;
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const filePath = join(FLEET_DIR, file);
      const config = JSON.parse(readFileSync(filePath, "utf-8"));
      const before = config.windows?.length || 0;
      config.windows = (config.windows || []).filter((w: { name: string }) => w.name.toLowerCase() !== windowNameLower);
      if (config.windows.length < before) {
        writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m removed from ${file}`);
        removed = true;
      }
    }
  } catch { /* fleet dir may not exist */ }
  return removed;
}
