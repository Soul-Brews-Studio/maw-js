import { openSync, closeSync, unlinkSync, existsSync, mkdirSync, writeSync, readSync, fstatSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOCK_DIR = join(homedir(), ".maw");
const LOCK_PATH = join(LOCK_DIR, "update.lock");

/**
 * Is process `pid` currently alive?  `kill(pid, 0)` is a no-op signal that
 * tests the existence of the process without touching it.  ESRCH means the
 * pid is gone.  EPERM means it's alive but we don't own it (still counts
 * as alive for our purposes).
 */
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

/**
 * withUpdateLock — run fn() while holding an exclusive update lock.
 *
 * Uses filesystem O_EXCL + PID content so crashed holders are detected
 * without waiting out the full timeout.  On EEXIST we read the lock's
 * PID; if the process is gone we steal the lock immediately.  Otherwise
 * we poll up to 60s.  Dedicated signal handlers release the lock on
 * SIGINT / SIGTERM so CI/test kills don't leave stale state.
 */
export async function withUpdateLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });

  const DEADLINE = Date.now() + 60_000;
  let fd: number | null = null;
  let announcedWait = false;
  while (true) {
    try {
      fd = openSync(LOCK_PATH, "wx"); // O_EXCL — fails if exists
      // fd-based write prevents path-TOCTOU (an attacker swapping LOCK_PATH for
      // a symlink between openSync and the write would otherwise redirect the
      // PID into an arbitrary file).  See #562 / #552.
      const pidBytes = Buffer.from(String(process.pid));
      writeSync(fd, pidBytes, 0, pidBytes.length, 0);
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Steal stale lock: if holder PID is dead, remove + retry immediately.
      // fd-based read for the same TOCTOU reason as the write above.
      let holderPid = NaN;
      let readFd: number | null = null;
      try {
        readFd = openSync(LOCK_PATH, "r");
        const size = fstatSync(readFd).size;
        const buf = Buffer.alloc(Math.min(size, 64));
        readSync(readFd, buf, 0, buf.length, 0);
        holderPid = parseInt(buf.toString("utf-8").trim(), 10);
      } catch { /* treat as stale — holderPid stays NaN */ }
      finally { if (readFd !== null) { try { closeSync(readFd); } catch {} } }
      if (!isAlive(holderPid)) {
        console.warn(`\x1b[33m⚠\x1b[0m stale update lock (pid ${holderPid || "?"} gone) — taking over`);
        try { unlinkSync(LOCK_PATH); } catch {}
        continue;
      }
      if (Date.now() > DEADLINE) {
        console.warn(`\x1b[33m⚠\x1b[0m update lock held for >60s by live pid ${holderPid} — giving up`);
        throw new Error(`update lock timeout: pid ${holderPid} still holds ${LOCK_PATH}`);
      }
      if (!announcedWait) {
        console.log(`  \x1b[90m⋯ another 'maw update' (pid ${holderPid}) is running, waiting up to 60s…\x1b[0m`);
        announcedWait = true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Release on abrupt termination (SIGINT / SIGTERM) so stale locks don't
  // leak when CI or a test timeout kills the process.
  const release = () => {
    try { if (fd !== null) closeSync(fd); } catch {}
    try { unlinkSync(LOCK_PATH); } catch {}
  };
  const sigInt = () => { release(); process.exit(130); };
  const sigTerm = () => { release(); process.exit(143); };
  process.once("SIGINT", sigInt);
  process.once("SIGTERM", sigTerm);

  try {
    return await fn();
  } finally {
    process.removeListener("SIGINT", sigInt);
    process.removeListener("SIGTERM", sigTerm);
    release();
  }
}
