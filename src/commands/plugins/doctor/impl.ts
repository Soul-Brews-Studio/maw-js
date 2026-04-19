import { existsSync, readFileSync, readlinkSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join, dirname, resolve } from "path";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

export interface DoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export async function cmdDoctor(args: string[] = []): Promise<DoctorResult> {
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const positional = args.filter(a => !a.startsWith("--"));
  const only = positional[0];
  const allowDrift = flags.has("--allow-drift");
  const checks: DoctorResult["checks"] = [];

  if (!only || only === "install" || only === "all") {
    checks.push(await checkInstall());
  }
  if (!only || only === "version" || only === "all") {
    const vChecks = await checkVersionDrift();
    for (const c of vChecks) checks.push(c);
  }

  const hardOk = checks.every(c => c.ok);
  const onlyDriftFails = !hardOk && checks.every(c => c.ok || c.name.startsWith("version:"));
  const ok = hardOk || (allowDrift && onlyDriftFails);
  renderResults(checks, ok);
  return { ok, checks };
}

async function checkInstall(): Promise<{ name: string; ok: boolean; message: string }> {
  const binPath = join(homedir(), ".bun/bin/maw");
  const exists = existsSync(binPath);
  if (!exists) {
    console.log(`  ${YELLOW}⚠${RESET} maw binary missing at ${binPath}`);
    console.log(`  ${GRAY}attempting reinstall…${RESET}`);
    try {
      execSync("bun add -g github:Soul-Brews-Studio/maw-js", { stdio: "inherit" });
      const nowExists = existsSync(binPath);
      return {
        name: "install",
        ok: nowExists,
        message: nowExists
          ? "reinstalled from github:Soul-Brews-Studio/maw-js"
          : "reinstall did not produce the binary — manual intervention needed",
      };
    } catch (e: any) {
      return { name: "install", ok: false, message: `reinstall failed: ${e.message || e}` };
    }
  }
  try {
    const link = readlinkSync(binPath);
    const abs = link.startsWith("/") ? link : resolve(dirname(binPath), link);
    if (!existsSync(abs)) {
      return { name: "install", ok: false, message: `binary is a broken symlink → ${abs}` };
    }
  } catch { /* not a symlink — that's fine */ }
  return { name: "install", ok: true, message: "maw binary present and resolvable" };
}

/**
 * Version drift: compare source package.json version to each running maw
 * process's `/info` endpoint version (#638). MVP covers pm2 only.
 *
 * Returns a list (one per running maw, or a single synthetic entry when
 * pm2/source lookup fails). Drift → ok:false; exit code gating lives in
 * cmdDoctor via the --allow-drift flag.
 */
async function checkVersionDrift(): Promise<DoctorResult["checks"]> {
  const source = readSourceVersion();
  if (!source) {
    return [{ name: "version:source", ok: false, message: "could not read package.json version" }];
  }

  const procs = listPm2MawProcs();
  if (procs === null) {
    return [{ name: "version:pm2", ok: true, message: `pm2 unavailable — source ${source} (no running maw to compare)` }];
  }
  if (procs.length === 0) {
    return [{ name: "version:pm2", ok: true, message: `no running maw — source ${source}` }];
  }

  const results: DoctorResult["checks"] = [];
  for (const p of procs) {
    const port = p.port ?? defaultPort();
    const label = `version:${p.name}${p.pmId != null ? `#${p.pmId}` : ""}`;
    try {
      const running = await fetchInfoVersion(port);
      if (running === null) {
        results.push({ name: label, ok: false, message: `unreachable at :${port} — source ${source}` });
      } else if (running === source) {
        results.push({ name: label, ok: true, message: `aligned (${source}) :${port}` });
      } else {
        results.push({ name: label, ok: false, message: `drift — running ${running}, source ${source} :${port}` });
      }
    } catch (e: any) {
      results.push({ name: label, ok: false, message: `probe failed: ${e?.message || e} :${port}` });
    }
  }
  return results;
}

function readSourceVersion(): string | null {
  try {
    const pkgPath = join(import.meta.dir, "..", "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function defaultPort(): number {
  const envPort = Number(process.env.MAW_PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3456;
}

interface Pm2Proc {
  name: string;
  pmId?: number;
  port?: number;
}

function listPm2MawProcs(): Pm2Proc[] | null {
  let raw: string;
  try {
    raw = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return null;
  }
  let procs: any[];
  try {
    procs = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(procs)) return [];
  const out: Pm2Proc[] = [];
  for (const p of procs) {
    if (!p || typeof p.name !== "string") continue;
    if (p.name !== "maw" && !p.name.startsWith("maw-")) continue;
    const env = p.pm2_env?.env || p.pm2_env || {};
    const envPort = Number(env?.MAW_PORT ?? env?.PORT);
    out.push({
      name: p.name,
      pmId: typeof p.pm_id === "number" ? p.pm_id : undefined,
      port: Number.isFinite(envPort) && envPort > 0 ? envPort : undefined,
    });
  }
  return out;
}

async function fetchInfoVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}/info`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body: any = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function renderResults(checks: DoctorResult["checks"], ok: boolean): void {
  console.log("");
  console.log(`  ${ok ? GREEN + "✓" : RED + "✗"} maw doctor${RESET}`);
  for (const c of checks) {
    const icon = iconFor(c);
    console.log(`    ${icon} ${c.name}${RESET}: ${c.message}`);
  }
  console.log("");
}

function iconFor(c: { name: string; ok: boolean; message: string }): string {
  if (c.ok) return GREEN + "✓";
  if (c.name.startsWith("version:") && c.message.startsWith("drift")) return YELLOW + "⚠";
  return RED + "✗";
}
