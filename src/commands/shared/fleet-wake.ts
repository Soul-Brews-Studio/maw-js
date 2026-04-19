import { readdirSync } from "fs";
import { tmux, FLEET_DIR, saveTabOrder, restoreTabOrder } from "../../sdk";
import { loadConfig, buildCommand, getEnvVars } from "../../config";
import { ensureSessionRunning } from "./wake";
import { loadFleet } from "./fleet-load";
import { respawnMissingWorktrees, resumeActiveItems } from "./fleet-resume";
import {
  isSshTransportError,
  runWakeLoopFailSoft,
  type WakeStep,
} from "./fleet-wake-failsoft";

// Re-export for back-compat with existing callers/tests.
export { firstStderrLine, isSshTransportError, runWakeLoopFailSoft } from "./fleet-wake-failsoft";
export type { WakeStep, WakeLoopResult } from "./fleet-wake-failsoft";

export async function cmdSleep() {
  const sessions = loadFleet();
  let killed = 0;

  for (const sess of sessions) {
    // Save tab order before killing (so wake can restore positions)
    await saveTabOrder(sess.name);
    try {
      await tmux.killSession(sess.name);
      console.log(`  \x1b[90m●\x1b[0m ${sess.name} — sleep`);
      killed++;
    } catch {
      // Session didn't exist
    }
  }

  console.log(`\n  ${killed} sessions put to sleep.\n`);
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

  let winCount = 0;
  let sessCount = 0;

  const steps: WakeStep[] = sessions.map((sess, si) => ({
    sessName: sess.name,
    run: async () => {
      const progress = `[${si + 1}/${sessions.length}]`;

      if (await tmux.hasSession(sess.name)) {
        console.log(`  \x1b[33m●\x1b[0m ${progress} ${sess.name} — already awake`);
        return;
      }

      process.stdout.write(`  \x1b[90m⏳\x1b[0m ${progress} ${sess.name}...`);

      const first = sess.windows[0];
      const firstPath = `${loadConfig().ghqRoot}/${first.repo}`;
      await tmux.newSession(sess.name, { window: first.name, cwd: firstPath });
      for (const [key, val] of Object.entries(getEnvVars())) {
        await tmux.setEnvironment(sess.name, key, val);
      }

      if (!sess.skip_command) {
        await new Promise(r => setTimeout(r, 300));
        try { await tmux.sendText(`${sess.name}:${first.name}`, buildCommand(first.name)); } catch { /* ok */ }
      }
      winCount++;

      for (let i = 1; i < sess.windows.length; i++) {
        const win = sess.windows[i];
        const winPath = `${loadConfig().ghqRoot}/${win.repo}`;
        try {
          await tmux.newWindow(sess.name, win.name, { cwd: winPath });
          if (!sess.skip_command) {
            await new Promise(r => setTimeout(r, 300));
            await tmux.sendText(`${sess.name}:${win.name}`, buildCommand(win.name));
          }
          winCount++;
        } catch (e) {
          // Window creation may fail (duplicate name, bad path). Propagate
          // ssh transport errors so the outer loop records a remote-skip.
          if (isSshTransportError(e)) throw e;
        }
      }

      await tmux.selectWindow(`${sess.name}:1`);
      sessCount++;
      console.log(` \x1b[32m✓\x1b[0m ${sess.windows.length} windows`);
    },
  }));

  const { remoteSkipped, warnings } = await runWakeLoopFailSoft(steps);
  for (const w of warnings) {
    // Clear any in-progress "⏳ [n/m] name..." line before emitting.
    process.stdout.write("\r\x1b[2K");
    console.log(`  \x1b[33m⚠\x1b[0m ${w}`);
  }

  // Scan disk for worktrees not covered by fleet configs and spawn them
  const wtExtra = await respawnMissingWorktrees(sessions);
  winCount += wtExtra;

  // Verify all windows actually started Claude (not stuck on zsh)
  if (sessCount > 0) {
    console.log("  \x1b[36mVerifying sessions...\x1b[0m");
    await new Promise(r => setTimeout(r, 3000)); // let shells init
    let totalRetried = 0;
    for (const sess of sessions) {
      if (sess.skip_command) continue;
      try {
        totalRetried += await ensureSessionRunning(sess.name);
      } catch (e) {
        if (isSshTransportError(e)) continue; // already counted as remote-skipped
        throw e;
      }
    }
    if (totalRetried > 0) {
      console.log(`  \x1b[33m${totalRetried} window(s) retried.\x1b[0m`);
    } else {
      console.log("  \x1b[32m✓ All windows running.\x1b[0m");
    }
  }

  // Restore saved tab order (from previous sleep)
  let totalReordered = 0;
  for (const sess of sessions) {
    try {
      totalReordered += await restoreTabOrder(sess.name);
    } catch (e) {
      if (isSshTransportError(e)) continue; // already counted as remote-skipped
      throw e;
    }
  }
  if (totalReordered > 0) {
    console.log(`  \x1b[36m↻ ${totalReordered} window(s) reordered to saved positions.\x1b[0m`);
  }

  const skippedSuffix = remoteSkipped > 0 ? ` \x1b[33m${remoteSkipped} remote skipped.\x1b[0m` : "";
  console.log(`\n  \x1b[32m${sessCount} sessions, ${winCount} windows woke up.\x1b[0m${skippedSuffix}\n`);

  if (opts.resume) {
    console.log("  \x1b[36mResuming active board items...\x1b[0m\n");
    await resumeActiveItems();
  }
}
