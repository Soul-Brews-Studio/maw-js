import { execSync } from "child_process";

let cachedVersionString: string | undefined;
let cachedVersionLabel: string | undefined;

export function normalizeRuntimeVersion(version: unknown): string {
  return typeof version === "string" && version.trim() ? version.trim() : "dev";
}

export function formatRuntimeVersionLabel(version: unknown, hash = "", buildDate = ""): string {
  const normalized = normalizeRuntimeVersion(version);
  return `v${normalized}${hash ? ` (${hash})` : ""}${buildDate ? ` built ${buildDate}` : ""}`;
}

function readPackageVersion(): string {
  try {
    const pkg = require("../../../package.json");
    return normalizeRuntimeVersion(pkg?.version);
  } catch {
    return "dev";
  }
}

function readGitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: import.meta.dir,
      stdio: "pipe",
    }).toString().trim();
  } catch {
    return "";
  }
}

function readBuildDate(): string {
  try {
    const raw = execSync("git log -1 --format=%ci", {
      cwd: import.meta.dir,
      stdio: "pipe",
    }).toString().trim();
    const d = new Date(raw);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${raw.slice(0, 10)} ${days[d.getDay()]} ${raw.slice(11, 16)}`;
  } catch {
    return "";
  }
}

export function getRuntimeVersionLabel(): string {
  if (cachedVersionLabel !== undefined) return cachedVersionLabel;

  cachedVersionLabel = formatRuntimeVersionLabel(readPackageVersion(), readGitHash(), readBuildDate());
  return cachedVersionLabel;
}

export function getRuntimeVersionString(): string {
  if (cachedVersionString !== undefined) return cachedVersionString;

  cachedVersionString = `maw ${getRuntimeVersionLabel()}`;
  return cachedVersionString;
}
