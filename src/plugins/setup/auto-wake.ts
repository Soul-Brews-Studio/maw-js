import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, userInfo } from "node:os";

export interface AutoWakeDeps {
  execFileSync: typeof execFileSync;
  existsSync: typeof existsSync;
  cwd: () => string;
  platform: () => NodeJS.Platform;
  user: () => string;
}

export interface AutoWakeOptions {
  dryRun?: boolean;
  user?: string;
  repoRoot?: string;
}

export interface AutoWakeStep {
  command: string[];
  skipped?: boolean;
  output?: string;
}

export interface AutoWakeResult {
  steps: AutoWakeStep[];
}

export function createAutoWakeDeps(overrides: Partial<AutoWakeDeps> = {}): AutoWakeDeps {
  return {
    execFileSync,
    existsSync,
    cwd: () => process.cwd(),
    platform,
    user: () => userInfo().username || process.env.USER || "unknown",
    ...overrides,
  };
}

function runStep(command: string[], opts: AutoWakeOptions, deps: AutoWakeDeps): AutoWakeStep {
  if (opts.dryRun) return { command, skipped: true };
  const output = deps.execFileSync(command[0], command.slice(1), {
    cwd: opts.repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) as string;
  return { command, output };
}

function repoRoot(opts: AutoWakeOptions, deps: AutoWakeDeps): string {
  const root = resolve(opts.repoRoot || deps.cwd());
  if (!deps.existsSync(join(root, "ecosystem.config.cjs"))) {
    throw new Error(`ecosystem.config.cjs not found in ${root}; run from the maw-js repo or pass --repo <path>`);
  }
  return root;
}

export async function setupAutoWake(
  opts: AutoWakeOptions = {},
  deps: Partial<AutoWakeDeps> = {},
): Promise<AutoWakeResult> {
  const io = createAutoWakeDeps(deps);
  if (io.platform() === "win32" && !opts.dryRun) {
    throw new Error("maw setup auto-wake is only implemented for Linux/macOS service managers");
  }

  const root = repoRoot(opts, io);
  const user = opts.user || io.user();
  const steps: AutoWakeStep[] = [];

  if (io.platform() === "darwin" && !opts.dryRun) {
    throw new Error("macOS launchd auto-wake setup is not implemented yet; use maw fleet doctor --reboot for diagnostics");
  }

  steps.push(runStep(["loginctl", "enable-linger", user], { ...opts, repoRoot: root }, io));
  steps.push(runStep(["pm2", "startup", "systemd", "-u", user, "--hp", io.platform() === "darwin" ? `/Users/${user}` : `/home/${user}`], { ...opts, repoRoot: root }, io));
  steps.push(runStep(["pm2", "start", "ecosystem.config.cjs", "--only", "maw-boot"], { ...opts, repoRoot: root }, io));
  steps.push(runStep(["pm2", "save"], { ...opts, repoRoot: root }, io));

  return { steps };
}
