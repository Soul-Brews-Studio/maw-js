import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, userInfo } from "node:os";
import { listSnapshots } from "../../core/fleet/snapshot";

export type RebootCheckLevel = "pass" | "fail" | "warn";

export interface RebootCheck {
  name: string;
  level: RebootCheckLevel;
  message: string;
  fix?: string;
  detail?: Record<string, unknown>;
}

export interface RebootDoctorDeps {
  execFileSync: typeof execFileSync;
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  homedir: () => string;
  platform: () => NodeJS.Platform;
  user: () => string;
  env: NodeJS.ProcessEnv;
  listSnapshots: typeof listSnapshots;
}

export function createRebootDoctorDeps(overrides: Partial<RebootDoctorDeps> = {}): RebootDoctorDeps {
  return {
    execFileSync,
    existsSync,
    readFileSync,
    homedir,
    platform,
    user: () => userInfo().username || process.env.USER || "unknown",
    env: process.env,
    listSnapshots,
    ...overrides,
  };
}

function checkLinuxLinger(user: string, deps: RebootDoctorDeps): RebootCheck {
  try {
    const raw = String(deps.execFileSync("loginctl", ["show-user", user, "--property=Linger", "--value"], { encoding: "utf8" })).trim();
    const enabled = raw === "yes" || raw === "true" || raw === "Linger=yes";
    return enabled
      ? { name: "linger", level: "pass", message: `linger enabled for ${user}` }
      : {
          name: "linger",
          level: "fail",
          message: `linger is not enabled for ${user}`,
          fix: `maw setup auto-wake --user ${user}`,
          detail: { observed: raw },
        };
  } catch (e: any) {
    return {
      name: "linger",
      level: "warn",
      message: "could not inspect loginctl linger state",
      fix: `maw setup auto-wake --user ${user}`,
      detail: { error: e?.message || String(e) },
    };
  }
}

function checkPm2Service(user: string, deps: RebootDoctorDeps): RebootCheck {
  const service = `pm2-${user}.service`;
  try {
    const raw = String(deps.execFileSync("systemctl", ["is-enabled", service], { encoding: "utf8" })).trim();
    return raw === "enabled"
      ? { name: "pm2-service", level: "pass", message: `${service} is enabled` }
      : {
          name: "pm2-service",
          level: "fail",
          message: `${service} is ${raw || "not enabled"}`,
          fix: `pm2 startup systemd -u ${user} --hp ${deps.homedir()}`,
          detail: { observed: raw },
        };
  } catch (e: any) {
    return {
      name: "pm2-service",
      level: "warn",
      message: `could not confirm ${service} is enabled`,
      fix: `pm2 startup systemd -u ${user} --hp ${deps.homedir()}`,
      detail: { error: e?.message || String(e) },
    };
  }
}

function pm2DumpPath(deps: RebootDoctorDeps): string {
  return join(deps.env.PM2_HOME || join(deps.homedir(), ".pm2"), "dump.pm2");
}

function checkPm2Dump(deps: RebootDoctorDeps): RebootCheck {
  const dump = pm2DumpPath(deps);
  if (!deps.existsSync(dump)) {
    return {
      name: "pm2-dump",
      level: "fail",
      message: `pm2 dump not found at ${dump}`,
      fix: "maw setup auto-wake",
      detail: { dump },
    };
  }
  try {
    const parsed = JSON.parse(String(deps.readFileSync(dump, "utf8")));
    const apps = Array.isArray(parsed) ? parsed : [];
    const names = new Set(apps.map((app: any) => app?.name).filter((name: unknown): name is string => typeof name === "string"));
    const hasServer = names.has("maw") || names.has("maw-server");
    const missing = [
      ...(hasServer ? [] : ["maw or maw-server"]),
      ...(names.has("maw-boot") ? [] : ["maw-boot"]),
    ];
    if (missing.length === 0) {
      return { name: "pm2-dump", level: "pass", message: "pm2 dump contains maw server and maw-boot", detail: { dump } };
    }
    return {
      name: "pm2-dump",
      level: "fail",
      message: `pm2 dump missing ${missing.join(", ")}`,
      fix: "maw setup auto-wake",
      detail: { dump, apps: [...names], missing },
    };
  } catch (e: any) {
    return {
      name: "pm2-dump",
      level: "fail",
      message: `pm2 dump is unreadable: ${dump}`,
      fix: "pm2 save",
      detail: { dump, error: e?.message || String(e) },
    };
  }
}

function checkRecentSnapshot(deps: RebootDoctorDeps): RebootCheck {
  let snapshots: ReturnType<typeof listSnapshots> = [];
  try {
    snapshots = deps.listSnapshots();
  } catch (e: any) {
    return {
      name: "snapshot",
      level: "fail",
      message: "could not inspect fleet snapshots",
      fix: "maw fleet snapshot manual",
      detail: { error: e?.message || String(e) },
    };
  }
  const newest = snapshots
    .map((s) => ({ ...s, time: Date.parse(s.timestamp) }))
    .filter((s) => Number.isFinite(s.time))
    .sort((a, b) => b.time - a.time)[0];
  if (!newest) {
    return {
      name: "snapshot",
      level: "fail",
      message: "no fleet snapshots found",
      fix: "maw fleet snapshot manual",
    };
  }
  const ageMs = Date.now() - newest.time;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  return ageMs <= maxAgeMs
    ? { name: "snapshot", level: "pass", message: `latest snapshot is recent (${newest.file})`, detail: { timestamp: newest.timestamp } }
    : {
        name: "snapshot",
        level: "warn",
        message: `latest snapshot is older than 24h (${newest.file})`,
        fix: "maw fleet snapshot manual",
        detail: { timestamp: newest.timestamp },
      };
}

function checkMacLaunchd(deps: RebootDoctorDeps): RebootCheck {
  const plist = join(deps.homedir(), "Library", "LaunchAgents", "com.maw.boot.plist");
  return deps.existsSync(plist)
    ? { name: "launchd", level: "pass", message: "maw launchd plist is installed", detail: { plist } }
    : {
        name: "launchd",
        level: "fail",
        message: "maw launchd plist is not installed",
        fix: "macOS auto-wake setup is not implemented yet",
        detail: { plist },
      };
}

export function checkRebootReadiness(overrides: Partial<RebootDoctorDeps> = {}): RebootCheck[] {
  const deps = createRebootDoctorDeps(overrides);
  const user = deps.user();
  const checks: RebootCheck[] = [];

  if (deps.platform() === "darwin") {
    checks.push(checkMacLaunchd(deps));
  } else if (deps.platform() === "linux") {
    checks.push(checkLinuxLinger(user, deps));
    checks.push(checkPm2Service(user, deps));
    checks.push(checkPm2Dump(deps));
  } else {
    checks.push({
      name: "service-manager",
      level: "warn",
      message: `reboot doctor does not know how to inspect ${deps.platform()}`,
      fix: "manually verify your service manager starts maw-boot",
    });
  }

  checks.push(checkRecentSnapshot(deps));
  return checks;
}

