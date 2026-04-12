import { join } from "path";
import { readdirSync, renameSync, existsSync, unlinkSync, symlinkSync, mkdirSync } from "fs";
import { tmux } from "../tmux";
import { loadConfig } from "../config";
import { FLEET_DIR } from "../paths";
import { loadFleetEntries, getSessionNames } from "./fleet-load";

export async function cmdFleetLs() {
  const entries = loadFleetEntries();
  const disabled = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).length;
  const runningSessions = await getSessionNames();

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
  const numCount = new Map<number, number>();
  for (const e of entries) numCount.set(e.num, (numCount.get(e.num) || 0) + 1);
  if (![...numCount.values()].some(c => c > 1)) {
    console.log("\n  \x1b[32mNo conflicts found.\x1b[0m Fleet numbering is clean.\n");
    return;
  }

  const runningSessions = await getSessionNames();
  console.log("\n  \x1b[36mRenumbering fleet...\x1b[0m\n");
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));
  const regular = sorted.filter(e => e.num !== 99);

  let num = 1;
  for (const e of regular) {
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = `${newNum}-${e.groupName}`;
    const oldName = e.session.name;

    if (newFile !== e.file) {
      e.session.name = newName;
      const tmpPath = join(FLEET_DIR, `.tmp-${newFile}`);
      await Bun.write(tmpPath, JSON.stringify(e.session, null, 2) + "\n");
      renameSync(tmpPath, join(FLEET_DIR, newFile));
      const oldPath = join(FLEET_DIR, e.file);
      if (existsSync(oldPath) && newFile !== e.file) unlinkSync(oldPath);

      const runningMatch = runningSessions.find(s => s === oldName)
        || runningSessions.find(s => s.replace(/^\d+-/, "") === e.groupName);
      if (runningMatch && runningMatch !== newName) {
        try {
          await tmux.run("rename-session", "-t", runningMatch, newName);
          console.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux: ${runningMatch} → ${newName})`);
        } catch {
          console.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux rename failed: ${runningMatch})`);
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

  const numMap = new Map<number, string[]>();
  for (const e of entries) {
    const list = numMap.get(e.num) || [];
    list.push(e.groupName);
    numMap.set(e.num, list);
  }
  for (const [num, names] of numMap) {
    if (names.length > 1) issues.push(`\x1b[31mDuplicate #${String(num).padStart(2, "0")}\x1b[0m: ${names.join(", ")}`);
  }

  const oracleMap = new Map<string, string[]>();
  for (const e of entries) {
    for (const w of e.session.windows) {
      const oracles = oracleMap.get(w.name) || [];
      oracles.push(e.session.name);
      oracleMap.set(w.name, oracles);
    }
  }
  for (const [, sessions] of oracleMap) {
    if (sessions.length > 1) issues.push(`\x1b[33mDuplicate oracle\x1b[0m: in ${sessions.join(", ")}`);
  }

  const ghqRoot = loadConfig().ghqRoot;
  for (const e of entries) {
    for (const w of e.session.windows) {
      if (!existsSync(join(ghqRoot, w.repo))) issues.push(`\x1b[33mMissing repo\x1b[0m: ${w.repo} (in ${e.file})`);
    }
  }

  const runningSessions = await getSessionNames();
  const configNames = new Set(entries.map(e => e.session.name));
  for (const s of runningSessions) {
    if (!configNames.has(s)) issues.push(`\x1b[90mOrphan session\x1b[0m: tmux '${s}' has no fleet config`);
  }

  for (const e of entries) {
    if (!runningSessions.includes(e.session.name)) continue;
    try {
      const windows = await tmux.listWindows(e.session.name);
      const registeredWindows = new Set(e.session.windows.map(w => w.name));
      for (const w of windows.filter(w => !registeredWindows.has(w.name))) {
        issues.push(`\x1b[33mUnregistered window\x1b[0m: '${w.name}' in ${e.session.name} — won't survive reboot`);
      }
    } catch (err) { console.error(`  \x1b[33m⚠\x1b[0m failed to list windows for ${e.session.name}: ${err}`); }
  }

  console.log(`\n  \x1b[36mFleet Validation\x1b[0m (${entries.length} configs)\n`);
  if (issues.length === 0) {
    console.log("  \x1b[32m✓ All clear.\x1b[0m No issues found.\n");
  } else {
    for (const issue of issues) console.log(`  ⚠ ${issue}`);
    console.log(`\n  \x1b[31m${issues.length} issue(s) found.\x1b[0m\n`);
  }
}

export async function cmdFleetSync() {
  const entries = loadFleetEntries();
  let added = 0;
  const runningSessions = await getSessionNames();
  const ghqRoot = loadConfig().ghqRoot;

  for (const e of entries) {
    if (!runningSessions.includes(e.session.name)) continue;
    try {
      const winOut = await tmux.run("list-windows", "-t", e.session.name, "-F", "#{window_name}:#{pane_current_path}");
      const registeredNames = new Set(e.session.windows.map(w => w.name));
      for (const line of winOut.trim().split("\n").filter(Boolean)) {
        const [winName, cwdPath] = line.split(":");
        if (!winName || registeredNames.has(winName)) continue;
        let repo = "";
        if (cwdPath?.startsWith(ghqRoot + "/")) repo = cwdPath.slice(ghqRoot.length + 1);
        e.session.windows.push({ name: winName, repo });
        console.log(`  \x1b[32m+\x1b[0m ${winName} → ${e.file}${repo ? ` (${repo})` : ""}`);
        added++;
      }
    } catch (err) { console.error(`  \x1b[33m⚠\x1b[0m failed to sync ${e.session.name}: ${err}`); }
    if (added > 0) await Bun.write(join(FLEET_DIR, e.file), JSON.stringify(e.session, null, 2) + "\n");
  }

  if (added === 0) console.log("\n  \x1b[32m✓ Fleet in sync.\x1b[0m No unregistered windows.\n");
  else console.log(`\n  \x1b[32m${added} window(s) added to fleet configs.\x1b[0m\n`);
}

export async function cmdFleetSyncConfigs() {
  const repoFleetDir = join(import.meta.dir, "..", "..", "fleet");
  if (!existsSync(repoFleetDir)) { console.error(`  \x1b[31m✗\x1b[0m No fleet/ directory found in repo`); process.exit(1); }
  const files = readdirSync(repoFleetDir).filter(f => f.endsWith(".json"));
  if (files.length === 0) { console.log("  \x1b[90mNo fleet configs to sync.\x1b[0m"); return; }
  mkdirSync(FLEET_DIR, { recursive: true });
  let synced = 0;
  for (const file of files) {
    const src = join(repoFleetDir, file);
    const dest = join(FLEET_DIR, file);
    try { unlinkSync(dest); } catch { /* ok */ }
    symlinkSync(src, dest);
    synced++;
  }
  console.log(`  \x1b[32m✓ ${synced} fleet config(s) synced\x1b[0m → ${FLEET_DIR}`);
}
