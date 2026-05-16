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
import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

function resolveHome(): string {
  return process.env.MAW_HOME || join(homedir(), ".maw");
}

export function pidFile(): string {
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

function readPid(file = pidFile()): number {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return parseInt(buf.subarray(0, n).toString("utf-8").trim(), 10);
  } catch {
    return NaN;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
  }
}

function unlinkPid(file = pidFile()): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}

function processSummary(pid: number): string {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "pid=,etime=,command="], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    const line = raw.split("\n").at(-1)?.trim();
    if (!line) return "";
    const match = line.match(/^\s*\d+\s+(\S+)\s+(.+)$/);
    if (!match) return "";
    return `, uptime ${match[1]}, cmd: ${match[2].slice(0, 80)}`;
  } catch {
    return "";
  }
}

export function serveStatus(): { pid: number | null; alive: boolean; file: string } {
  const file = pidFile();
  const pid = readPid(file);
  if (!Number.isFinite(pid)) return { pid: null, alive: false, file };
  const alive = isAlive(pid);
  if (!alive) unlinkPid(file);
  return { pid, alive, file };
}

export function printServeStatus(): void {
  const status = serveStatus();
  if (!status.pid) {
    console.log(`maw serve: stopped (${status.file})`);
    return;
  }
  if (status.alive) {
    console.log(`maw serve: running (PID ${status.pid}${processSummary(status.pid)})`);
  } else {
    console.log(`maw serve: stopped — removed stale PID ${status.pid} (${status.file})`);
  }
}

function defaultEngineUrl(): string {
  return (process.env.MAW_ENGINE_URL || `http://127.0.0.1:${process.env.MAW_PORT || "3456"}`).replace(/\/+$/, "");
}

function formatEngineRegistration(registration: Record<string, unknown>): string {
  const plugin = typeof registration.plugin === "string" ? registration.plugin : "unknown";
  const prefix = typeof registration.prefix === "string" ? registration.prefix : "unknown-prefix";
  const upstream = typeof registration.upstream === "string" ? registration.upstream : "unknown-upstream";
  const health = typeof registration.health === "string" ? ` health=${registration.health}` : "";
  const events = Array.isArray(registration.events) && registration.events.length > 0
    ? ` events=${registration.events.join(",")}`
    : "";
  return `  - ${plugin}: ${prefix} → ${upstream}${health}${events}`;
}

async function fetchEngineRegistrations(engineUrl = defaultEngineUrl()): Promise<
  | { ok: true; engineUrl: string; registrations: Array<Record<string, unknown>> }
  | { ok: false; engineUrl: string; error: string }
> {
  try {
    const response = await fetch(`${engineUrl}/api/_engine/registrations`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return { ok: false, engineUrl, error: `HTTP ${response.status}` };
    const body = await response.json() as { registrations?: Array<Record<string, unknown>> };
    return { ok: true, engineUrl, registrations: Array.isArray(body.registrations) ? body.registrations : [] };
  } catch (err) {
    return { ok: false, engineUrl, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function printServeStatusWithPlugins(engineUrl = defaultEngineUrl()): Promise<void> {
  printServeStatus();
  const status = serveStatus();
  if (!status.alive) return;

  const result = await fetchEngineRegistrations(engineUrl);
  if (!result.ok) {
    console.log(`engine plugins: unavailable (${result.engineUrl}: ${result.error})`);
    return;
  }
  if (result.registrations.length === 0) {
    console.log(`engine plugins: none (${result.engineUrl})`);
    return;
  }
  console.log(`engine plugins (${result.engineUrl}):`);
  for (const registration of result.registrations) console.log(formatEngineRegistration(registration));
}

export function stopServe(): void {
  const status = serveStatus();
  if (!status.pid) {
    console.log("maw serve: already stopped");
    return;
  }
  if (!status.alive) {
    console.log(`maw serve: removed stale PID ${status.pid}`);
    return;
  }
  process.kill(status.pid, "SIGTERM");
  unlinkPid(status.file);
  console.log(`maw serve: stopped PID ${status.pid}`);
}

/**
 * Acquire the PID lock, or exit(1) with a clear error if another maw serve
 * is already running in this home.
 */
export function acquirePidLock(
  instanceName: string | null,
  opts: { forceTakeover?: boolean } = {},
): void {
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
      const prior = readPid(file);
      if (Number.isFinite(prior) && isAlive(prior)) {
        if (opts.forceTakeover) {
          process.kill(prior, "SIGTERM");
          unlinkPid(file);
          continue;
        }
        const label = instanceName ? ` as ${instanceName}` : "";
        console.error(`\x1b[31m✗\x1b[0m maw serve already running${label} (PID ${prior}${processSummary(prior)})`);
        console.error(`  stop:  \x1b[36mmaw serve stop\x1b[0m`);
        console.error(`  check: \x1b[36mmaw serve status\x1b[0m`);
        console.error(`  force: \x1b[36mmaw serve --force-takeover\x1b[0m`);
        process.exit(1);
      }
      // Stale PID — remove and retry the atomic create once.
      unlinkPid(file);
    }
  }

  // Clean up on clean shutdown. Best-effort — never crash if unlink fails.
  const cleanup = () => {
    unlinkPid(file);
  };
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);
}
