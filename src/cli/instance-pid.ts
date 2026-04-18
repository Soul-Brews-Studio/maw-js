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
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
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
  if (existsSync(file)) {
    try {
      const prior = parseInt(readFileSync(file, "utf-8").trim(), 10);
      if (Number.isFinite(prior) && isAlive(prior)) {
        const label = instanceName ? ` as ${instanceName}` : "";
        console.error(`\x1b[31m✗\x1b[0m another maw serve is already running${label} (PID ${prior}). Stop it first.`);
        process.exit(1);
      }
      // Stale PID — fall through and overwrite.
    } catch { /* malformed file — overwrite */ }
  }
  writeFileSync(file, String(process.pid));

  // Clean up on clean shutdown. Best-effort — never crash if unlink fails.
  const cleanup = () => {
    try { unlinkSync(file); } catch { /* already gone or disk full */ }
  };
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
}
