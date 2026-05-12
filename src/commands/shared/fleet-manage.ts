import { join } from "path";
import { existsSync, renameSync, unlinkSync, readdirSync } from "fs";
import { tmux, FLEET_DIR } from "../../sdk";
import { loadFleetEntries, getSessionNames } from "./fleet-load";

export async function cmdFleetLs(opts: { json?: boolean; verbose?: boolean } = {}) {
  const entries = loadFleetEntries();
  const disabled = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).length;

  const runningSessions = await getSessionNames();

  // #1118 — JSON output for tooling
  if (opts.json) {
    console.log(JSON.stringify({
      active: entries.length,
      disabled,
      entries: entries.map(e => ({
        num: e.num,
        name: e.session.name,
        windows: e.session.windows.length,
        running: runningSessions.includes(e.session.name),
        ...(opts.verbose && { windowDetails: e.session.windows, syncPeers: e.session.sync_peers }),
      })),
    }, null, 2));
    return;
  }

  // Detect conflicts (duplicate numbers)
  const numCount = new Map<number, string[]>();
  for (const e of entries) {
    const list = numCount.get(e.num) || [];
    list.push(e.groupName);
    numCount.set(e.num, list);
  }

  const conflicts = [...numCount.entries()].filter(([, names]) => names.length > 1);

  console.log(`\n  \x1b[36mFleet Configs\x1b[0m (${entries.length} active, ${disabled} disabled)\n`);

  if (opts.verbose) {
    for (const e of entries) {
      const numStr = String(e.num).padStart(2, "0");
      const isRunning = runningSessions.includes(e.session.name);
      const isConflict = (numCount.get(e.num)?.length ?? 0) > 1;
      let status = isRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[90mstopped\x1b[0m";
      if (isConflict) status += "  \x1b[31mCONFLICT\x1b[0m";
      console.log(`  ${numStr}  \x1b[33m${e.session.name}\x1b[0m  ${status}`);
      for (const w of e.session.windows) {
        console.log(`       \x1b[90m${w.name.padEnd(20)} ${w.repo}\x1b[0m`);
      }
    }
  } else {
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

  const runningSessions = await getSessionNames();

  console.log("\n  \x1b[36mRenumbering fleet...\x1b[0m\n");

  // Sort by current number, then by name for stability
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));

  // Skip 99-overview from renumbering
  const regular = sorted.filter(e => e.num !== 99);

  let num = 1;
  for (const e of regular) {
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = `${newNum}-${e.groupName}`;
    const oldName = e.session.name;

    if (newFile !== e.file) {
      // Update config.name in JSON — write to temp file then atomically rename
      e.session.name = newName;
      const tmpPath = join(FLEET_DIR, `.tmp-${newFile}`);
      await Bun.write(tmpPath, JSON.stringify(e.session, null, 2) + "\n");
      renameSync(tmpPath, join(FLEET_DIR, newFile));

      // Remove old file (only if name changed)
      const oldPath = join(FLEET_DIR, e.file);
      if (existsSync(oldPath) && newFile !== e.file) {
        unlinkSync(oldPath);
      }

      // Rename running tmux session (#84) — try exact name first, then pattern match
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
