import { tmux } from "../tmux";
import { detectSession } from "./wake";
import { saveTabOrder } from "../tab-order";
import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { takeSnapshot } from "../snapshot";

/**
 * maw sleep <oracle> [window]
 *
 * Gracefully stop a single Oracle agent's tmux window:
 * 1. Send /exit to the Claude session
 * 2. Wait 3 seconds
 * 3. If window still exists, kill it
 * 4. Log the event
 */
export async function cmdSleepOne(oracle: string, window?: string) {
  // Resolve session
  const session = await detectSession(oracle);
  if (!session) {
    console.error(`\x1b[31merror\x1b[0m: no running session found for '${oracle}'`);
    process.exit(1);
  }

  // Determine window name
  const windowName = window ? `${oracle}-${window}` : `${oracle}-oracle`;

  // Save tab order before sleeping (so wake can restore positions)
  await saveTabOrder(session);

  // Verify window exists
  let windows;
  try {
    windows = await tmux.listWindows(session);
  } catch {
    console.error(`\x1b[31merror\x1b[0m: could not list windows for session '${session}'`);
    process.exit(1);
  }

  // Normalize trailing dashes — tmux window names like "fireman-1w-test-"
  // cause exact-match failures and strand maw sleep (#206)
  const stripDash = (s: string) => s.replace(/-+$/, "");

  const target = windows.find(w => w.name === windowName || stripDash(w.name) === stripDash(windowName));
  if (!target) {
    // Try partial match (e.g. oracle-N-name pattern)
    const nameSuffix = window || "oracle";
    const fuzzy = windows.find(w =>
      stripDash(w.name) === stripDash(windowName) ||
      new RegExp(`^${oracle}-\\d+-${nameSuffix}-?$`).test(w.name)
    );
    if (!fuzzy) {
      console.error(`\x1b[31merror\x1b[0m: window '${windowName}' not found in session '${session}'`);
      console.error(`\x1b[90mavailable:\x1b[0m ${windows.map(w => w.name).join(", ")}`);
      process.exit(1);
    }
    // Use the fuzzy-matched name
    return await doSleep(session, fuzzy.name, oracle);
  }

  await doSleep(session, windowName, oracle);
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
