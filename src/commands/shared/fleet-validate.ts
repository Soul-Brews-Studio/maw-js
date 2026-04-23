import { join } from "path";
import { existsSync } from "fs";
import { tmux } from "../../sdk";
import { getGhqRoot } from "../../config/ghq-root";
import { loadFleetEntries, getSessionNames } from "./fleet-load";

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
  const reposRoot = join(getGhqRoot(), "github.com");
  for (const e of entries) {
    for (const w of e.session.windows) {
      const repoPath = join(reposRoot, w.repo);
      if (!existsSync(repoPath)) {
        issues.push(`\x1b[33mMissing repo\x1b[0m: ${w.repo} (in ${e.file})`);
      }
    }
  }

  // 4. Running sessions without config
  const runningSessions = await getSessionNames();
  const configNames = new Set(entries.map(e => e.session.name));
  for (const s of runningSessions) {
    if (!configNames.has(s)) {
      issues.push(`\x1b[90mOrphan session\x1b[0m: tmux '${s}' has no fleet config`);
    }
  }

  // 5. Running windows not in fleet config (won't survive reboot)
  for (const e of entries) {
    if (!runningSessions.includes(e.session.name)) continue;
    try {
      const windows = await tmux.listWindows(e.session.name);
      const registeredWindows = new Set(e.session.windows.map(w => w.name));
      const unregistered = windows.filter(w => !registeredWindows.has(w.name));
      for (const w of unregistered) {
        issues.push(`\x1b[33mUnregistered window\x1b[0m: '${w.name}' in ${e.session.name} — won't survive reboot`);
      }
    } catch (err) { console.error(`  \x1b[33m⚠\x1b[0m failed to list windows for ${e.session.name}: ${err}`); }
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
