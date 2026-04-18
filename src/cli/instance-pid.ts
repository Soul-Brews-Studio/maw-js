/**
 * PID handshake for `maw serve` (#566).
 *
 * On serve start: write PID to `<MAW_HOME>/maw.pid`. Refuse a second serve
 * invocation if a prior PID is still alive. Cleans up on SIGTERM/SIGINT.
 *
 * When --as is omitted, this still runs — it just uses the default
 * `~/.maw/maw.pid` location. Backward-compat: prior alpha never wrote a PID
 * file, so stale absence is the default state; nothing to reconcile.
 */
import { openSync, readSync, writeSync, closeSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function resolveHome(): string {
  return process.env.MAW_HOME || join(homedir(), ".maw");
}

function pidFile(): string {
  return join(resolveHome(), "maw.pid");
}

/** Check if a process with `pid` is alive. Uses signal 0 (no-op probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = no such process. EPERM = alive but we lack permission (still alive).
    return e?.code === "EPERM";
  }
}

/**
 * Acquire the PID lock, or exit(1) with a clear error if another maw serve
 * is already running in this home.
 */
export function acquirePidLock(instanceName: string | null): void {
  const home = resolveHome();
  mkdirSync(home, { recursive: true });
  const file = pidFile();

  // Atomic create-or-fail (O_CREAT|O_EXCL). Avoids the TOCTOU gap between
  // existsSync+writeFileSync. On success we own the lock. On EEXIST we probe
  // the prior PID; if stale, remove and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break; // acquired
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // Someone holds (or held) the lock — probe liveness.
      // fd-based read prevents path-TOCTOU (symlink swap between wx open and
      // the probe read). Mirrors the #562 / #581 fix in src/cli/update-lock.ts.
      // Fixed 64-byte buffer — PIDs are ≤20 digits, no fstatSync needed.
      let prior = NaN;
      let readFd: number | null = null;
      try {
        readFd = openSync(file, "r");
        const buf = Buffer.alloc(64);
        const n = readSync(readFd, buf, 0, buf.length, 0);
        prior = parseInt(buf.subarray(0, n).toString("utf-8").trim(), 10);
      } catch { /* malformed — treat as stale */ }
      finally { if (readFd !== null) { try { closeSync(readFd); } catch {} } }
      if (Number.isFinite(prior) && isAlive(prior)) {
        const label = instanceName ? ` as ${instanceName}` : "";
        console.error(`\x1b[31m✗\x1b[0m another maw serve is already running${label} (PID ${prior}). Stop it first.`);
        process.exit(1);
      }
      // Stale PID — remove and retry the atomic create once.
      try { unlinkSync(file); } catch { /* already gone */ }
    }
  }

  // Clean up on clean shutdown. Best-effort — never crash if unlink fails.
  const cleanup = () => {
    try { unlinkSync(file); } catch { /* already gone or disk full */ }
  };
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
}
