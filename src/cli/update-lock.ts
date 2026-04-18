import { openSync, closeSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOCK_DIR = join(homedir(), ".maw");
const LOCK_PATH = join(LOCK_DIR, "update.lock");

/**
 * withUpdateLock — run fn() while holding an exclusive update lock.
 *
 * Uses filesystem O_EXCL. If another maw update is in progress, prints a
 * waiting message and polls every 500ms up to 60s. After that, assumes
 * the lock holder crashed and takes over (the `.prev` stash in cmd-update
 * is the safety net if that assumption is wrong).
 */
export async function withUpdateLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });

  const START = Date.now();
  const DEADLINE = START + 60_000;
  let fd: number | null = null;
  let announcedWait = false;
  while (true) {
    try {
      fd = openSync(LOCK_PATH, "wx"); // O_EXCL — fails if exists
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > DEADLINE) {
        console.warn(`\x1b[33m⚠\x1b[0m update lock held for >60s — taking over (prior holder may have crashed)`);
        try { unlinkSync(LOCK_PATH); } catch {}
        continue;
      }
      if (!announcedWait) {
        console.log(`  \x1b[90m⋯ another 'maw update' is running, waiting up to 60s…\x1b[0m`);
        announcedWait = true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  try {
    return await fn();
  } finally {
    try { closeSync(fd!); } catch {}
    try { unlinkSync(LOCK_PATH); } catch {}
  }
}
