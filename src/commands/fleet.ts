import { join } from "path";
import { readdirSync, renameSync, existsSync } from "fs";
import { ssh } from "../ssh";
import { tmux } from "../tmux";
import { loadConfig, buildCommand, getEnvVars } from "../config";

interface FleetWindow {
  name: string;
  repo: string;
}

interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
}

const FLEET_DIR = join(import.meta.dir, "../../fleet");

function loadFleet(): FleetSession[] {
  const files = readdirSync(FLEET_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();

  return files.map(f => {
    const raw = require(join(FLEET_DIR, f));
    return raw as FleetSession;
  });
}

interface FleetEntry {
  file: string;
  num: number;
  groupName: string;
  session: FleetSession;
}

function loadFleetEntries(): FleetEntry[] {
  const files = readdirSync(FLEET_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();

  return files.map(f => {
    const raw = require(join(FLEET_DIR, f));
    const match = f.match(/^(\d+)-(.+)\.json$/);
    return {
      file: f,
      num: match ? parseInt(match[1], 10) : 0,
      groupName: match ? match[2] : f.replace(".json", ""),
      session: raw as FleetSession,
    };
  });
}

export async function cmdFleetLs() {
  const entries = loadFleetEntries();
  const disabled = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).length;

  // Detect running tmux sessions
  let runningSessions: string[] = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split("\n").filter(Boolean);
  } catch { /* tmux not running */ }

  // Detect conflicts (duplicate numbers)
  const numCount = new Map<number, string[]>();
  for (const e of entries) {
    const list = numCount.get(e.num) || [];
    list.push(e.groupName);
    numCount.set(e.num, list);
  }

  const conflicts = [...numCount.entries()].filter(([, names]) => names.length > 1);

  console.log(`\n  \x1b[36mFleet Configs\x1b[0m (${entries.length} active, ${disabled} disabled)\n`);
  console.log(`  ${"#".padEnd(4)} ${"Session".padEnd(20)} ${"Win".padEnd(5)} Status`);
  console.log(`  ${"─".repeat(4)} ${"─".repeat(20)} ${"─".repeat(5)} ${"─".repeat(20)}`);

  for (const e of entries) {
    const numStr = String(e.num).padStart(2, "0");
    const name = e.session.name.padEnd(20);
    const wins = String(e.session.windows.length).padEnd(5);
    const isRunning = runningSessions.includes(e.session.name);
    const isConflict = (numCount.get(e.num)?.length ?? 0) > 1;

    let status = isRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[90mstopped\x1b[0m";
    if (isConflict) status += "  \x1b[31mCONFLICT\x1b[0m";

    console.log(`  ${numStr}  ${name} ${wins} ${status}`);
  }

  if (conflicts.length > 0) {
    console.log(`\n  \x1b[31m⚠ ${conflicts.length} conflict(s) found.\x1b[0m Run \x1b[36mmaw fleet renumber\x1b[0m to fix.`);
  }
  console.log();
}

export async function cmdFleetRenumber() {
  const entries = loadFleetEntries();

  // Check for conflicts first
  const numCount = new Map<number, number>();
  for (const e of entries) numCount.set(e.num, (numCount.get(e.num) || 0) + 1);
  const hasConflicts = [...numCount.values()].some(c => c > 1);

  if (!hasConflicts) {
    console.log("\n  \x1b[32mNo conflicts found.\x1b[0m Fleet numbering is clean.\n");
    return;
  }

  // Detect running tmux sessions
  let runningSessions: string[] = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split("\n").filter(Boolean);
  } catch { /* tmux not running */ }

  console.log("\n  \x1b[36mRenumbering fleet...\x1b[0m\n");

  // Sort by current number, then by name for stability
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));

  // Skip 99-overview from renumbering
  const regular = sorted.filter(e => e.num !== 99);
  const overview = sorted.filter(e => e.num === 99);

  let num = 1;
  for (const e of regular) {
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = `${newNum}-${e.groupName}`;
    const oldName = e.session.name;

    if (newFile !== e.file) {
      // Update config.name in JSON
      e.session.name = newName;
      await Bun.write(join(FLEET_DIR, newFile), JSON.stringify(e.session, null, 2) + "\n");

      // Remove old file (only if name changed)
      const oldPath = join(FLEET_DIR, e.file);
      if (existsSync(oldPath) && newFile !== e.file) {
        const { unlinkSync } = require("fs");
        unlinkSync(oldPath);
      }

      // Rename running tmux session if it matches old name
      if (runningSessions.includes(oldName)) {
        try {
          await ssh(`tmux rename-session -t '${oldName}' '${newName}'`);
          console.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux renamed)`);
        } catch {
          console.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux rename failed)`);
        }
      } else {
        console.log(`  ${e.file.padEnd(28)} → ${newFile}`);
      }
    } else {
      console.log(`  ${e.file.padEnd(28)}   (unchanged)`);
    }
    num++;
  }

  console.log(`\n  \x1b[32mDone.\x1b[0m ${regular.length} configs renumbered.\n`);
}

export async function cmdFleetValidate() {
  const entries = loadFleetEntries();
  const issues: string[] = [];

  // 1. Duplicate numbers
  const numMap = new Map<number, string[]>();
  for (const e of entries) {
    const list = numMap.get(e.num) || [];
    list.push(e.groupName);
    numMap.set(e.num, list);
  }
  for (const [num, names] of numMap) {
    if (names.length > 1) {
      issues.push(`\x1b[31mDuplicate #${String(num).padStart(2, "0")}\x1b[0m: ${names.join(", ")}`);
    }
  }

  // 2. Oracle in multiple active configs
  const oracleMap = new Map<string, string[]>();
  for (const e of entries) {
    for (const w of e.session.windows) {
      const oracles = oracleMap.get(w.name) || [];
      oracles.push(e.session.name);
      oracleMap.set(w.name, oracles);
    }
  }
  for (const [oracle, sessions] of oracleMap) {
    if (sessions.length > 1) {
      issues.push(`\x1b[33mDuplicate oracle\x1b[0m: ${oracle} in ${sessions.join(", ")}`);
    }
  }

  // 3. Config references repo that doesn't exist
  const ghqRoot = loadConfig().ghqRoot;
  for (const e of entries) {
    for (const w of e.session.windows) {
      const repoPath = join(ghqRoot, w.repo);
      if (!existsSync(repoPath)) {
        issues.push(`\x1b[33mMissing repo\x1b[0m: ${w.repo} (in ${e.file})`);
      }
    }
  }

  // 4. Running sessions without config
  let runningSessions: string[] = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split("\n").filter(Boolean);
    const configNames = new Set(entries.map(e => e.session.name));
    for (const s of runningSessions) {
      if (!configNames.has(s)) {
        issues.push(`\x1b[90mOrphan session\x1b[0m: tmux '${s}' has no fleet config`);
      }
    }
  } catch { /* tmux not running */ }

  // 5. Running windows not in fleet config (won't survive reboot)
  for (const e of entries) {
    if (!runningSessions.includes(e.session.name)) continue;
    try {
      const winOut = await ssh(`tmux list-windows -t '${e.session.name}' -F '#{window_name}' 2>/dev/null`);
      const runningWindows = winOut.trim().split("\n").filter(Boolean);
      const registeredWindows = new Set(e.session.windows.map(w => w.name));
      const unregistered = runningWindows.filter(w => !registeredWindows.has(w));
      for (const w of unregistered) {
        issues.push(`\x1b[33mUnregistered window\x1b[0m: '${w}' in ${e.session.name} — won't survive reboot`);
      }
    } catch {}
  }

  // Report
  console.log(`\n  \x1b[36mFleet Validation\x1b[0m (${entries.length} configs)\n`);

  if (issues.length === 0) {
    console.log("  \x1b[32m✓ All clear.\x1b[0m No issues found.\n");
  } else {
    for (const issue of issues) {
      console.log(`  ⚠ ${issue}`);
    }
    console.log(`\n  \x1b[31m${issues.length} issue(s) found.\x1b[0m\n`);
  }
}

export async function cmdFleetSync() {
  const entries = loadFleetEntries();
  let added = 0;

  // Get running sessions
  let runningSessions: string[] = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split("\n").filter(Boolean);
  } catch { return; }

  const ghqRoot = loadConfig().ghqRoot;

  for (const e of entries) {
    if (!runningSessions.includes(e.session.name)) continue;

    try {
      const winOut = await ssh(`tmux list-windows -t '${e.session.name}' -F '#{window_name}:#{pane_current_path}' 2>/dev/null`);
      const runningWindows = winOut.trim().split("\n").filter(Boolean);
      const registeredNames = new Set(e.session.windows.map(w => w.name));

      for (const line of runningWindows) {
        const [winName, cwdPath] = line.split(":");
        if (!winName || registeredNames.has(winName)) continue;

        // Derive repo from cwd (strip ghqRoot prefix)
        let repo = "";
        if (cwdPath?.startsWith(ghqRoot + "/")) {
          repo = cwdPath.slice(ghqRoot.length + 1);
        }

        e.session.windows.push({ name: winName, repo });
        console.log(`  \x1b[32m+\x1b[0m ${winName} → ${e.file}${repo ? ` (${repo})` : ""}`);
        added++;
      }
    } catch {}

    // Write updated config
    if (added > 0) {
      const filePath = join(FLEET_DIR, e.file);
      await Bun.write(filePath, JSON.stringify(e.session, null, 2) + "\n");
    }
  }

  if (added === 0) {
    console.log("\n  \x1b[32m✓ Fleet in sync.\x1b[0m No unregistered windows.\n");
  } else {
    console.log(`\n  \x1b[32m${added} window(s) added to fleet configs.\x1b[0m\n`);
  }
}

export async function cmdSleep() {
  const sessions = loadFleet();
  let killed = 0;

  for (const sess of sessions) {
    try {
      await ssh(`tmux kill-session -t '${sess.name}' 2>/dev/null`);
      console.log(`  \x1b[90m●\x1b[0m ${sess.name} — sleep`);
      killed++;
    } catch {
      // Session didn't exist
    }
  }

  console.log(`\n  ${killed} sessions put to sleep.\n`);
}

/** After fleet spawn, send /recap to oracles with active Pulse board items */
async function resumeActiveItems() {
  const repo = "laris-co/pulse-oracle";
  try {
    const issuesJson = await ssh(
      `gh issue list --repo ${repo} --state open --json number,title,labels --limit 50`
    );
    const issues: { number: number; title: string; labels: { name: string }[] }[] = JSON.parse(issuesJson || "[]");

    // Find issues assigned to oracles (label: oracle:<name>)
    const oracleItems = issues
      .filter(i => !i.labels.some(l => l.name === "daily-thread"))
      .map(i => ({
        ...i,
        oracle: i.labels.find(l => l.name.startsWith("oracle:"))?.name.replace("oracle:", ""),
      }))
      .filter(i => i.oracle);

    if (!oracleItems.length) {
      console.log("  \x1b[90mNo active board items to resume.\x1b[0m");
      return;
    }

    // Group by oracle, send /recap once per oracle
    const byOracle = new Map<string, typeof oracleItems>();
    for (const item of oracleItems) {
      const list = byOracle.get(item.oracle!) || [];
      list.push(item);
      byOracle.set(item.oracle!, list);
    }

    for (const [oracle, items] of byOracle) {
      const windowName = `${oracle}-oracle`;
      // Find which session has this window
      const sessions = await tmux.listSessions();
      for (const sess of sessions) {
        try {
          const windows = await tmux.listWindows(sess.name);
          const win = windows.find(w => w.name.toLowerCase() === windowName.toLowerCase());
          if (win) {
            const titles = items.map(i => `#${i.number}`).join(", ");
            // Wait for Claude to be ready (give it time to start)
            await new Promise(r => setTimeout(r, 2000));
            await tmux.sendText(`${sess.name}:${win.name}`, `/recap --deep — Resume after reboot. Active items: ${titles}`);
            console.log(`  \x1b[32m↻\x1b[0m ${oracle}: /recap sent (${titles})`);
            break;
          }
        } catch { /* window not found in this session */ }
      }
    }
  } catch (e) {
    console.log(`  \x1b[33mresume skipped:\x1b[0m ${e}`);
  }
}

export async function cmdWakeAll(opts: { kill?: boolean; all?: boolean; resume?: boolean } = {}) {
  const allSessions = loadFleet();
  // Skip dormant (20+) unless --all flag is passed
  const sessions = opts.all
    ? allSessions
    : allSessions.filter(s => {
        const num = parseInt(s.name.split("-")[0], 10);
        return isNaN(num) || num < 20 || num >= 99;
      });
  const skipped = allSessions.length - sessions.length;

  if (opts.kill) {
    console.log(`\n  \x1b[33mKilling existing sessions...\x1b[0m\n`);
    await cmdSleep();
  }

  const disabled = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).length;
  const skipMsg = skipped > 0 ? `, ${skipped} dormant skipped` : "";
  console.log(`\n  \x1b[36mWaking fleet...\x1b[0m  (${sessions.length} sessions${disabled ? `, ${disabled} disabled` : ""}${skipMsg})\n`);

  let sessCount = 0;
  let winCount = 0;

  for (const sess of sessions) {
    // Check if session already exists
    try {
      await ssh(`tmux has-session -t '${sess.name}' 2>/dev/null`);
      console.log(`  \x1b[33m●\x1b[0m ${sess.name} — already awake`);
      continue;
    } catch {
      // Good — doesn't exist yet
    }

    // Create session with first window
    const first = sess.windows[0];
    const firstPath = `${loadConfig().ghqRoot}/${first.repo}`;
    await ssh(`tmux new-session -d -s '${sess.name}' -n '${first.name}' -c '${firstPath}'`);
    // Set env vars on session (not visible in tmux output)
    for (const [key, val] of Object.entries(getEnvVars())) {
      await ssh(`tmux set-environment -t '${sess.name}' '${key}' '${val}'`);
    }

    if (!sess.skip_command) {
      try { await ssh(`tmux send-keys -t '${sess.name}:${first.name}' '${buildCommand(first.name)}' Enter`); } catch { /* ok */ }
    }
    winCount++;

    // Add remaining windows
    for (let i = 1; i < sess.windows.length; i++) {
      const win = sess.windows[i];
      const winPath = `${loadConfig().ghqRoot}/${win.repo}`;
      try {
        await ssh(`tmux new-window -t '${sess.name}' -n '${win.name}' -c '${winPath}'`);
        if (!sess.skip_command) {
          await ssh(`tmux send-keys -t '${sess.name}:${win.name}' '${buildCommand(win.name)}' Enter`);
        }
        winCount++;
      } catch {
        // Window creation might fail (duplicate name, bad path)
      }
    }

    // Select first window
    try { await ssh(`tmux select-window -t '${sess.name}:1'`); } catch { /* ok */ }
    sessCount++;
    console.log(`  \x1b[32m●\x1b[0m ${sess.name} — ${sess.windows.length} windows`);
  }

  console.log(`\n  \x1b[32m${sessCount} sessions, ${winCount} windows woke up.\x1b[0m\n`);

  if (opts.resume) {
    console.log("  \x1b[36mResuming active board items...\x1b[0m\n");
    await resumeActiveItems();
  }
}
