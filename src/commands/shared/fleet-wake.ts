import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmux, FLEET_DIR, saveTabOrder, restoreTabOrder } from "../../sdk";
import { buildCommand, getEnvVars } from "../../config";
import { getGhqRoot } from "../../config/ghq-root";
import { ensureSessionRunning } from "./wake";
import { loadFleet } from "./fleet-load";
import { respawnMissingWorktrees, resumeActiveItems } from "./fleet-resume";
import { pinSessionWide, pinWindowWide } from "./wake-pane-size";
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
      // #748 — Oracle repos live at <ghqRoot>/<repo> directly (e.g. /root/projects/neo-oracle),
      // not under github.com/<org>/<repo>. Falling back to /root via missing-cwd was making
      // every Oracle session inherit Labubu's CLAUDE.md identity.
      const firstPath = join(getGhqRoot(), first.repo);
      // #748 follow-up — tmux silently falls back to $HOME when -c <missing-path>,
      // which re-surfaces the wrong-CLAUDE.md bug if ghqRoot resolves to a stale value
      // (e.g. test fixture leak setting "/tmp/nope"). Refuse to spawn into a missing
      // path; raise a clear error instead of silently inheriting the wrong identity.
      if (!existsSync(firstPath)) {
        throw new Error(
          `wake: refusing to spawn ${sess.name} — cwd "${firstPath}" does not exist. ` +
          `Check ghqRoot resolution (config.ghqRoot, $GHQ_ROOT, \`ghq root\`) and fleet config repo "${first.repo}".`,
        );
      }
      await tmux.newSession(sess.name, { window: first.name, cwd: firstPath });
      await pinSessionWide(sess.name);
      for (const [key, val] of Object.entries(getEnvVars())) {
        await tmux.setEnvironment(sess.name, key, val);
      }

      if (!sess.skip_command) {
        await new Promise(r => setTimeout(r, 300));
        // #1096 — auto-inject channels for fleet sessions
        // #1195 Phase 2 — prefer <firstPath>/.claude/channel.json over global config
        const { getChannelPluginIds, getChannelEnv } = await import("./channel-loader");
        const oracleStem = first.name.replace(/-oracle$/, "");
        const chIds = getChannelPluginIds(oracleStem, undefined, firstPath);
        const chEnv = getChannelEnv(oracleStem, undefined, firstPath);
        for (const [k, v] of Object.entries(chEnv)) {
          await tmux.setEnvironment(sess.name, k, v);
        }
        const wakeOpts = chIds.length ? { channels: chIds } : undefined;
        try { await tmux.sendText(`${sess.name}:${first.name}`, buildCommand(first.name, wakeOpts)); } catch { /* ok */ }
      }
      winCount++;

      for (let i = 1; i < sess.windows.length; i++) {
        const win = sess.windows[i];
        const winPath = join(getGhqRoot(), win.repo);
        if (!existsSync(winPath)) {
          // Skip rather than throw — first-window throw already surfaced the
          // root cause; per-window failures should fail-soft so other windows
          // in the same session still wake.
          process.stderr.write(
            `[maw] wake: skipping ${sess.name}:${win.name} — cwd "${winPath}" does not exist.\n`,
          );
          continue;
        }
        try {
          await tmux.newWindow(sess.name, win.name, { cwd: winPath });
          await pinWindowWide(`${sess.name}:${win.name}`);
          if (!sess.skip_command) {
            await new Promise(r => setTimeout(r, 300));
            const winStem = win.name.replace(/-oracle$/, "");
            // #1195 Phase 2 — prefer <winPath>/.claude/channel.json over global config
            const { getChannelPluginIds: gcp } = await import("./channel-loader");
            const winChIds = gcp(winStem, undefined, winPath);
            const winOpts = winChIds.length ? { channels: winChIds } : undefined;
            await tmux.sendText(`${sess.name}:${win.name}`, buildCommand(win.name, winOpts));
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
