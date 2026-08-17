/**
 * Last-resort process guards: no single client frame may take the whole
 * dashboard down.
 *
 * Its own module rather than a function inside server.ts, for a reason the test
 * suite found the hard way: importing `core/server` runs the plugin lifecycle
 * and attempts a real `Bun.serve`, so any default-suite test that imported it to
 * reach this function started a server and fought the live maw for port 3456.
 * A guard whose test cannot be written safely is a guard that stops being
 * tested — and nothing here needs server internals.
 *
 * Background: on 2026-08-10 a single ws frame carrying `"target": null` reached
 * `target.replace` inside an async attach(), and the resulting unhandled
 * rejection killed `maw serve` outright — Colony went blind for the whole fleet
 * while every oracle under it kept running fine. That specific hole is closed at
 * its source in transport/pty.ts. This is the net underneath, because the shape
 * of it — an async handler invoked without await, on any route — is one a future
 * edit can reintroduce for free, and the blast radius is never proportional to
 * the mistake.
 */

let installed = false;

/**
 * Log fatal async failures and keep serving.
 *
 * Deliberately continues rather than exits. That is the wrong default for a
 * batch job and the right one for a long-lived server whose death costs more
 * than any single request it is serving.
 *
 * Idempotent: startBunGatewayServer can run more than once in a process (tests,
 * TLS restarts), and re-registering would multiply every future log line by the
 * number of starts. Returns whether it installed, so callers can assert it.
 */
export function installProcessGuards(log: { error: (message: string) => void }): boolean {
  if (installed) return false;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error(`[serve:guard] unhandled rejection (server kept running): ${detail}`);
  });
  process.on("uncaughtException", (err) => {
    log.error(`[serve:guard] uncaught exception (server kept running): ${err?.stack ?? String(err)}`);
  });
  return true;
}

/** Test seam: forget the install so a fresh assertion can be made. */
export function resetProcessGuardsForTest(): void {
  installed = false;
}
