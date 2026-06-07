import { listSessions, capture } from "../../../sdk";
import { loadFleetEntries, type FleetEntry } from "../../shared/fleet-load";
import { findWorktrees, detectSession } from "../../shared/wake";
import { resolveOracleSafe } from "./impl-helpers";
import { UserError } from "../../../core/util/user-error";

export async function cmdOracleAbout(oracle: string) {
  const name = oracle.toLowerCase();
  const sessions = await listSessions();

  // Gather all signals first so we can distinguish "real oracle, sparse data"
  // from "no such oracle" — the latter must error rather than print an
  // empty-but-valid-looking record (#390.2).
  const { repoPath, repoName, parentDir } = await resolveOracleSafe(name);
  const session = await detectSession(name);

  let fleetEntry: FleetEntry | null = null;
  let fleetFile: string | null = null;
  let fleetWindowCount = 0;
  try {
    for (const entry of loadFleetEntries()) {
      const windows = entry.session?.windows ?? [];
      const hasOracle = windows.some(
        (w: any) => w.name?.toLowerCase() === `${name}-oracle` || w.name?.toLowerCase() === name
      );
      if (hasOracle) {
        fleetEntry = entry;
        fleetFile = entry.file;
        fleetWindowCount = windows.length;
        break;
      }
    }
  } catch { /* expected: fleet dirs may not exist or may contain bad JSON */ }

  if (!repoPath && !session && !fleetFile) {
    throw new UserError(`no oracle named '${oracle}' — try: maw oracle ls`);
  }

  // Heading — preserve user input casing. Auto-capitalizing turned 'mawjs'
  // into 'Mawjs', which is wrong (oracle names are lowercase by convention).
  console.log(`\n  \x1b[36mOracle — ${oracle}\x1b[0m\n`);

  // Repo
  console.log(`  Repo:      ${repoPath || "(not found)"}`);

  // Session + windows
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
  if (fleetFile) {
    const actualWindows = session
      ? (sessions.find(s => s.name === session)?.windows.length || 0)
      : 0;
    console.log(`  Fleet:     ${fleetFile} (${fleetWindowCount} registered, ${actualWindows} running)`);
    if (actualWindows > fleetWindowCount) {
      // Find which windows are unregistered
      const registeredNames = new Set((fleetEntry?.session?.windows || []).map((w: any) => w.name));
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
