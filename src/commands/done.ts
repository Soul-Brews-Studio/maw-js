import { listSessions, ssh } from "../ssh";
import { tmux } from "../tmux";
import { loadConfig } from "../config";
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { FLEET_DIR } from "../paths";

/**
 * maw done <window-name>
 *
 * Clean up a finished worktree window:
 * 1. Kill the tmux window
 * 2. Remove git worktree (if it is one)
 * 3. Remove from fleet config JSON
 */
export async function cmdDone(windowName_: string) {
  let windowName = windowName_;
  const sessions = await listSessions();
  const ghqRoot = loadConfig().ghqRoot;

  // Find the window in running sessions (case-insensitive)
  const windowNameLower = windowName.toLowerCase();
  let sessionName: string | null = null;
  let windowIndex: number | null = null;
  for (const s of sessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; windowIndex = w.index; windowName = w.name; break; }
  }

  // 0. Signal parent inbox (#81) — write before kill so parent knows
  const from = process.env.CLAUDE_AGENT_NAME || windowName;
  const parentSession = sessionName;
  if (parentSession) {
    // Parent = session's main window (index 1 or lowest)
    const parentWindow = sessions.find(s => s.name === parentSession)?.windows[0]?.name;
    if (parentWindow) {
      const parentTarget = parentWindow.replace(/[^a-zA-Z0-9_-]/g, "");
      const inboxDir = join(homedir(), ".oracle", "inbox");
      const signal = JSON.stringify({ ts: new Date().toISOString(), from, type: "done", msg: `worktree ${windowName} completed`, thread: null }) + "\n";
      try { mkdirSync(inboxDir, { recursive: true }); appendFileSync(join(inboxDir, `${parentTarget}.jsonl`), signal); } catch {}
    }
  }

  // 1. Kill tmux window
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

  // 2. Remove git worktree — find via fleet config repo path
  let removedWorktree = false;
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      const win = (config.windows || []).find((w: any) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo) continue;

      const fullPath = join(ghqRoot, win.repo);
      // Check if it's a worktree (repo name contains .wt-)
      if (win.repo.includes(".wt-")) {
        // Find the main repo to run git worktree remove
        const parts = win.repo.split("/");
        const wtDir = parts.pop()!;
        const org = parts.join("/");
        const mainRepo = wtDir.split(".wt-")[0];
        const mainPath = join(ghqRoot, org, mainRepo);

        try {
          // Detect branch name before removing
          let branch = "";
          try { branch = (await ssh(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch {}
          await ssh(`git -C '${mainPath}' worktree remove '${fullPath}' --force`);
          await ssh(`git -C '${mainPath}' worktree prune`);
          console.log(`  \x1b[32m✓\x1b[0m removed worktree ${win.repo}`);
          removedWorktree = true;
          // Clean up branch
          if (branch && branch !== "main" && branch !== "HEAD") {
            try { await ssh(`git -C '${mainPath}' branch -d '${branch}'`); console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch {}
          }
        } catch (e: any) {
          console.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e.message || e}`);
        }
      }
      break;
    }
  } catch { /* fleet dir may not exist */ }

  if (!removedWorktree) {
    // Try to find worktree by scanning ghq for .wt- dirs matching the window name
    // EXACT match only — substring matching killed unrelated worktrees (#60)
    try {
      const suffix = windowName.replace(/^[^-]+-/, ""); // e.g. "mother-schedule" → "schedule"
      const ghqOut = await ssh(`find ${ghqRoot} -maxdepth 3 -name '*.wt-*' -type d 2>/dev/null`);
      const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
      // Exact match: worktree dir must end with .wt-N-<suffix> or .wt-<suffix>
      const exactMatch = allWtPaths.filter(p => {
        const base = p.split("/").pop()!;
        const wtSuffix = base.replace(/^.*\.wt-(?:\d+-)?/, "");
        return wtSuffix.toLowerCase() === suffix.toLowerCase();
      });
      for (const wtPath of exactMatch) {
        const base = wtPath.split("/").pop()!
        const mainRepo = base.split(".wt-")[0];
        const mainPath = wtPath.replace(base, mainRepo);
        try {
          let branch = "";
          try { branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch {}
          await ssh(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
          await ssh(`git -C '${mainPath}' worktree prune`);
          console.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
          removedWorktree = true;
          if (branch && branch !== "main" && branch !== "HEAD") {
            try { await ssh(`git -C '${mainPath}' branch -d '${branch}'`); console.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch {}
          }
        } catch {}
      }
    } catch { /* no matching worktrees */ }
  }

  if (!removedWorktree) {
    console.log(`  \x1b[90m○\x1b[0m no worktree to remove (may be a main window)`);
  }

  // 3. Remove from fleet config
  let removedFromConfig = false;
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const filePath = join(FLEET_DIR, file);
      const config = JSON.parse(readFileSync(filePath, "utf-8"));
      const before = config.windows?.length || 0;
      config.windows = (config.windows || []).filter((w: any) => w.name.toLowerCase() !== windowNameLower);
      if (config.windows.length < before) {
        writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m removed from ${file}`);
        removedFromConfig = true;
      }
    }
  } catch { /* fleet dir may not exist */ }

  if (!removedFromConfig) {
    console.log(`  \x1b[90m○\x1b[0m not in any fleet config`);
  }

  console.log();
}
