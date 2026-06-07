/**
 * sleep.ts — vendored `cmdSleepOne` (Phase 2 vendor, #918 follow-up).
 *
 * Mirrors `src/commands/plugins/sleep/impl.ts::cmdSleepOne` so that
 * `src/api/sessions.ts` (and any other src/core / src/api / src/lib consumer)
 * can gracefully stop an oracle's tmux window without reaching across the
 * plugin boundary into the sleep plugin.
 *
 * After the follow-up "prune" PR removes the sleep plugin's source, this
 * vendored copy is the canonical location for the per-oracle sleep flow.
 *
 * Behavior — gracefully stop a single Oracle agent's tmux window:
 *   1. Send /exit to the Claude session
 *   2. Wait 3 seconds
 *   3. If window still exists, kill it
 *   4. Append a `sleep` event to the XDG data-primary maw-log.jsonl
 */
import { tmux, saveTabOrder, takeSnapshot } from "../sdk";
import { detectSession } from "../commands/shared/wake";
import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { runSleepLifecycleHooks } from "../plugin/lifecycle";
import { mawMessageLogPath } from "../core/xdg";

export async function cmdSleepOne(oracle: string, window?: string) {
  const session = await detectSession(oracle);
  if (!session) {
    throw new Error(`no running session found for '${oracle}'`);
  }

  const windowName = window ? `${oracle}-${window}` : `${oracle}-oracle`;

  // Save tab order before sleeping (so wake can restore positions)
  await saveTabOrder(session);
  await runSleepLifecycleHooks({
    oracle,
    target: oracle,
    session,
    window: windowName,
  });

  let windows;
  try {
    windows = await tmux.listWindows(session);
  } catch {
    throw new Error(`could not list windows for session '${session}'`);
  }

  // Normalize trailing dashes — tmux window names like "fireman-1w-test-"
  // cause exact-match failures and strand maw sleep (#206)
  const stripDash = (s: string) => s.replace(/-+$/, "");

  const target = windows.find(w => w.name === windowName || stripDash(w.name) === stripDash(windowName));
  if (!target) {
    const nameSuffix = window || "oracle";
    const fuzzy = windows.find(w =>
      stripDash(w.name) === stripDash(windowName) ||
      new RegExp(`^${oracle}-\\d+-${nameSuffix}-?$`).test(w.name)
    );
    if (!fuzzy) {
      console.error(`\x1b[90mavailable:\x1b[0m ${windows.map(w => w.name).join(", ")}`);
      throw new Error(`window '${windowName}' not found in session '${session}'`);
    }
    return await doSleep(session, fuzzy.name, oracle);
  }

  await doSleep(session, windowName, oracle);
}

async function doSleep(session: string, windowName: string, oracle: string) {
  const target = `${session}:${windowName}`;

  console.log(`\x1b[90m...\x1b[0m sending /exit to ${target}`);
  try {
    for (const ch of "/exit") {
      await tmux.sendKeysLiteral(target, ch);
    }
    await tmux.sendKeys(target, "Enter");
  } catch {
    // Window might already be gone
  }

  await new Promise(r => setTimeout(r, 3000));

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
    console.log(`  \x1b[32m✓\x1b[0m ${windowName} stopped`);
  }

  const logFile = mawMessageLogPath();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type: "sleep",
    oracle,
    window: windowName,
  }) + "\n";
  try {
    await mkdir(dirname(logFile), { recursive: true });
    await appendFile(logFile, line);
  } catch (e) { console.error(`\x1b[33m⚠\x1b[0m sleep log write failed: ${e}`); }

  console.log(`\x1b[32msleep\x1b[0m ${oracle} (${windowName})`);

  takeSnapshot("sleep").catch(() => {});
}
