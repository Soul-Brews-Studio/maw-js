import { listSessions, capture, FLEET_DIR } from "../../../sdk";
import { findWorktrees, detectSession } from "../../shared/wake";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { resolveOracleSafe } from "./impl-helpers";

export async function cmdOracleAbout(oracle: string) {
  const name = oracle.toLowerCase();
  const sessions = await listSessions();

  console.log(`\n  \x1b[36mOracle — ${oracle.charAt(0).toUpperCase() + oracle.slice(1)}\x1b[0m\n`);

  // Repo
  const { repoPath, repoName, parentDir } = await resolveOracleSafe(name);
  console.log(`  Repo:      ${repoPath || "(not found)"}`);

  // Session + windows
  const session = await detectSession(name);
  if (session) {
    const s = sessions.find(s => s.name === session);
    const windows = s?.windows || [];
    console.log(`  Session:   ${session} (${windows.length} windows)`);
    for (const w of windows) {
      let status = "\x1b[90m○\x1b[0m";
      try {
        const content = await capture(`${session}:${w.index}`, 3);
        status = content.trim() ? "\x1b[32m●\x1b[0m" : "\x1b[33m●\x1b[0m";
      } catch { /* expected: capture may fail for inactive pane */ }
      console.log(`    ${status} ${w.name}`);
    }
  } else {
    console.log(`  Session:   (none)`);
  }

  // Worktrees
  if (parentDir) {
    const wts = await findWorktrees(parentDir, repoName);
    console.log(`  Worktrees: ${wts.length}`);
    for (const wt of wts) {
      console.log(`    ${wt.name} → ${wt.path}`);
    }
  }

  // Fleet config
  const fleetDir = FLEET_DIR;
  let fleetFile: string | null = null;
  let fleetWindowCount = 0;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const hasOracle = (config.windows || []).some(
        (w: any) => w.name.toLowerCase() === `${name}-oracle` || w.name.toLowerCase() === name
      );
      if (hasOracle) {
        fleetFile = file;
        fleetWindowCount = config.windows.length;
        break;
      }
    }
  } catch { /* expected: fleet dir may not exist */ }

  if (fleetFile) {
    const actualWindows = session
      ? (sessions.find(s => s.name === session)?.windows.length || 0)
      : 0;
    console.log(`  Fleet:     ${fleetFile} (${fleetWindowCount} registered, ${actualWindows} running)`);
    if (actualWindows > fleetWindowCount) {
      // Find which windows are unregistered
      const fleetConfig = JSON.parse(readFileSync(join(fleetDir, fleetFile), "utf-8"));
      const registeredNames = new Set((fleetConfig.windows || []).map((w: any) => w.name));
      const runningWindows = sessions.find(s => s.name === session)?.windows || [];
      const unregistered = runningWindows.filter(w => !registeredNames.has(w.name));

      console.log(`  \x1b[33m⚠\x1b[0m  ${unregistered.length} window(s) not in fleet config — won't survive reboot`);
      for (const w of unregistered) {
        console.log(`    \x1b[33m→\x1b[0m ${w.name}`);
      }
      console.log(`\n  \x1b[90mFix: add to fleet/${fleetFile}\x1b[0m`);
      console.log(`  \x1b[90m  maw fleet init          # regenerate all configs\x1b[0m`);
      console.log(`  \x1b[90m  maw fleet validate      # check for problems\x1b[0m`);
    }
  } else {
    console.log(`  Fleet:     (no config)`);
  }

  console.log();
}
