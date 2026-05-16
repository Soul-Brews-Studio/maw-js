import { tmux, listSessions } from "maw-js/sdk";
import { detectSession } from "maw-js/commands/shared/wake";
import { loadFleet } from "maw-js/commands/shared/fleet-load";
import { saveTabOrder } from "maw-js/sdk";
import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { takeSnapshot } from "maw-js/sdk";
import { runSleepLifecycleHooks } from "maw-js/plugin/lifecycle";
import { resolveSleepTarget } from "./resolve-target";

/**
 * maw sleep <target> [window]
 *
 * Gracefully stop a single Oracle agent's tmux window:
 * 1. Send /exit to the Claude session
 * 2. Wait 3 seconds
 * 3. If window still exists, kill it
 * 4. Log the event
 *
 * Resolution (Tier 1-2-3) lives in `./resolve-target.ts`.
 */
export async function cmdSleepOne(target: string, windowOverride?: string) {
  const resolved = await resolveSleepTarget(target, windowOverride, {
    listSessions,
    loadFleet,
    detectSession,
  });

  if (!resolved) {
    const sessions = await listSessions();
    const flatWindows = sessions.flatMap(s =>
      s.windows.map(w => `${s.name}:${w.name}`),
    );
    if (flatWindows.length > 0) {
      const head = flatWindows.slice(0, 10).join(", ");
      const more = flatWindows.length > 10 ? ` ... (+${flatWindows.length - 10} more)` : "";
      console.error(`\x1b[90mavailable:\x1b[0m ${head}${more}`);
    }
    throw new Error(`could not resolve sleep target: '${target}'`);
  }

  const { session, window: windowName } = resolved;

  // Save tab order before sleeping (so wake can restore positions)
  await saveTabOrder(session);
  await runSleepLifecycleHooks({
    oracle: target,
    target,
    session,
    window: windowName,
  });

  await doSleep(session, windowName, target);
}

async function doSleep(session: string, windowName: string, oracle: string) {
  const target = `${session}:${windowName}`;

  // 1. Send /exit for graceful shutdown
  console.log(`\x1b[90m...\x1b[0m sending /exit to ${target}`);
  try {
    // Send /exit char by char (slash command pattern from sendKeys in ssh.ts)
    for (const ch of "/exit") {
      await tmux.sendKeysLiteral(target, ch);
    }
    await tmux.sendKeys(target, "Enter");
  } catch {
    // Window might already be gone
  }

  // 2. Wait 3 seconds for graceful shutdown
  await new Promise(r => setTimeout(r, 3000));

  // 3. If window still exists, force kill
  try {
    const windows = await tmux.listWindows(session);
    const stripDash = (s: string) => s.replace(/-+$/, "");
    const stillExists = windows.some(w => w.name === windowName || stripDash(w.name) === stripDash(windowName));
    if (stillExists) {
      await tmux.killWindow(target);
      console.log(`  \x1b[33m!\x1b[0m force-killed ${windowName} (did not exit gracefully)`);
    } else {
      console.log(`  \x1b[32m✓\x1b[0m ${windowName} exited gracefully`);
    }
  } catch {
    // Session might be gone if it was the last window
    console.log(`  \x1b[32m✓\x1b[0m ${windowName} stopped`);
  }

  // 4. Log the sleep event
  const logDir = join(homedir(), ".oracle");
  const logFile = join(logDir, "maw-log.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type: "sleep",
    oracle,
    window: windowName,
  }) + "\n";
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(logFile, line);
  } catch (e) { console.error(`\x1b[33m⚠\x1b[0m sleep log write failed: ${e}`); }

  console.log(`\x1b[32msleep\x1b[0m ${oracle} (${windowName})`);

  // Snapshot after sleep
  takeSnapshot("sleep").catch(() => {});
}
