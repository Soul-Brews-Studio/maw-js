/**
 * `maw wait <name>` — block until a tmux session named `<name>` no longer
 * exists (#1306). Completes the POSIX-style job-control trio with
 * `maw bg` and `maw shell` (#1304).
 *
 * Returns immediately if the session never existed — "wait for nothing"
 * is satisfied without polling. Mirrors POSIX `wait %1` on a job that has
 * already finished.
 *
 * Polls `tmux.hasSession(name)` every `intervalSec` seconds (default 5).
 * Optional `timeoutSec` makes the wait bounded; on expiry, throws so the
 * outer handler can surface exit code 1.
 *
 * Out of scope (v1, per #1306 body):
 *   - process exit-code propagation (needs `maw bg` log capture; separate issue)
 *   - waiting on multiple names at once
 *   - waiting on `maw a` peer / remote sessions
 */
import { tmux } from "../../../core/transport/tmux-class";

export interface WaitOpts {
  /** Poll interval in seconds. Default 5. Fractional values allowed. */
  intervalSec?: number;
  /** Hard timeout in seconds. Throws on expiry. Omit for no timeout. */
  timeoutSec?: number;
}

/** Thrown when --timeout is exceeded. Caller maps to exit code 1. */
export class WaitTimeoutError extends Error {
  constructor(name: string, timeoutSec: number) {
    super(`timeout: session '${name}' still running after ${timeoutSec}s`);
    this.name = "WaitTimeoutError";
  }
}

export async function cmdWait(name: string, opts: WaitOpts = {}): Promise<void> {
  if (!name) throw new Error("session name required (usage: maw wait <name>)");

  const intervalSec = opts.intervalSec ?? 5;
  if (!(intervalSec > 0)) {
    throw new Error(`--interval must be positive (got ${opts.intervalSec})`);
  }
  if (opts.timeoutSec !== undefined && !(opts.timeoutSec > 0)) {
    throw new Error(`--timeout must be positive (got ${opts.timeoutSec})`);
  }

  // Fast path: session never existed → nothing to wait for. This matches
  // POSIX `wait` on a finished job: no error, no spin.
  if (!(await tmux.hasSession(name))) {
    console.log(`✓ session '${name}' not running — nothing to wait for`);
    return;
  }

  const intervalMs = intervalSec * 1000;
  const deadline = opts.timeoutSec ? Date.now() + opts.timeoutSec * 1000 : Infinity;

  // Loop body uses ts-ignore-style infinite condition; exits via return or throw.
  while (true) {
    if (Date.now() > deadline) {
      throw new WaitTimeoutError(name, opts.timeoutSec!);
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (!(await tmux.hasSession(name))) {
      console.log(`✓ session '${name}' ended`);
      return;
    }
  }
}
