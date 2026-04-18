/**
 * maw peers — file lock for concurrent writers (#572 nit 3).
 *
 * Mirrors the pattern in src/cli/update-lock.ts: O_EXCL create on a
 * sibling `.lock` file, write our pid, retry on EEXIST. If the holder
 * pid is gone (kill -0 → ESRCH) we steal the lock immediately rather
 * than waiting out the timeout. Synchronous (no await) so it composes
 * with the existing sync savePeers signature without a contract change.
 *
 * Sized for CLI use: 5s deadline, 50ms poll. peers.json writes are
 * sub-millisecond, so racing CLIs almost always succeed on first try.
 */
import { openSync, closeSync, unlinkSync, writeSync, readSync, existsSync } from "fs";

const DEADLINE_MS = 5_000;
const POLL_MS = 50;

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin — short waits only */ }
}

/** Run fn() while holding an exclusive lock on `<path>.lock`. Synchronous. */
export function withPeersLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + DEADLINE_MS;
  let fd: number | null = null;

  while (true) {
    try {
      fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
      // fd-based write — prevents path-TOCTOU symlink swap between open and write.
      // See #562 / #581 (exemplar fix in src/cli/update-lock.ts).
      const pidBytes = Buffer.from(String(process.pid));
      writeSync(fd, pidBytes, 0, pidBytes.length, 0);
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // fd-based read for the same TOCTOU reason as the write above.
      // Fixed 64-byte buffer — PIDs are ≤20 digits on every supported OS, so
      // no fstatSync needed (also avoids the CodeQL "stat-then-read" pattern).
      let holderPid = NaN;
      let readFd: number | null = null;
      try {
        readFd = openSync(lockPath, "r");
        const buf = Buffer.alloc(64);
        const n = readSync(readFd, buf, 0, buf.length, 0);
        holderPid = parseInt(buf.subarray(0, n).toString("utf-8").trim(), 10);
      } catch { /* empty/racy — treat as stale */ }
      finally { if (readFd !== null) { try { closeSync(readFd); } catch {} } }
      if (!isAlive(holderPid)) {
        try { unlinkSync(lockPath); } catch { /* race with another stealer is fine */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`peers lock timeout: pid ${holderPid} still holds ${lockPath}`);
      }
      sleepSync(POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    try { if (fd !== null) closeSync(fd); } catch { /* ignore */ }
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
