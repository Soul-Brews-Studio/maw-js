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
 *   4. Append a `sleep` event to ~/.oracle/maw-log.jsonl
 */
import { tmux, saveTabOrder, takeSnapshot, listSessions } from "../sdk";
import { detectSession } from "../commands/shared/wake";
import { loadFleetEntries } from "../commands/shared/fleet-load";
import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export async function cmdSleepOne(oracle: string, window?: string) {
  // If caller provides an explicit window name, use it directly
  if (window) {
    const session = await detectSession(oracle);
    if (!session) throw new Error(`no running session found for '${oracle}'`);
    await saveTabOrder(session);
    return doSleep(session, window, oracle);
  }

  const sessions = await listSessions();
  const targetLower = oracle.toLowerCase();

  // Tier 1: window-name match across ALL sessions
  for (const s of sessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === targetLower);
    if (w) {
      await saveTabOrder(s.name);
      return doSleep(s.name, w.name, oracle);
    }
  }

  // Tier 2: session-name match → use fleet's primary window
  const sess = sessions.find(s => s.name === oracle || s.name.endsWith(`-${oracle}`));
  if (sess) {
    const entry = loadFleetEntries().find(e => e.session.name === sess.name);
    const primary = entry?.session.windows[0]?.name ?? sess.windows[0]?.name;
    if (primary) {
      await saveTabOrder(sess.name);
      return doSleep(sess.name, primary, oracle);
    }
  }

  // Tier 3: detectSession (existing fleet-aware resolver)
  const session = await detectSession(oracle);
  if (!session) throw new Error(`no running session found for '${oracle}'`);
  const entry = loadFleetEntries().find(e => e.session.name === session);
  const primary = entry?.session.windows[0]?.name;
  if (!primary) throw new Error(`could not resolve window for '${oracle}'`);
  await saveTabOrder(session);
  return doSleep(session, primary, oracle);
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

  takeSnapshot("sleep").catch(() => {});
}
