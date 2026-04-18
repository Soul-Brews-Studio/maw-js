import { existsSync, readlinkSync } from "fs";
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
  const only = args[0];
  const checks: DoctorResult["checks"] = [];

  if (!only || only === "install" || only === "all") {
    checks.push(await checkInstall());
  }

  const ok = checks.every(c => c.ok);
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

function renderResults(checks: DoctorResult["checks"], ok: boolean): void {
  console.log("");
  console.log(`  ${ok ? GREEN + "✓" : RED + "✗"} maw doctor${RESET}`);
  for (const c of checks) {
    const icon = c.ok ? GREEN + "✓" : RED + "✗";
    console.log(`    ${icon} ${c.name}${RESET}: ${c.message}`);
  }
  console.log("");
}
