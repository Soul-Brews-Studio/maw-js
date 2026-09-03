import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "path";
import { loadFleet } from "./fleet-load";
import { getGhqRoot } from "../../config/ghq-root";

/**
 * Extract oracle name from a tmux target.
 *
 * Prefer the window segment when present so command-map overrides keyed by
 * window names still apply on wake/resume. Fall back to session slug when
 * window is numeric/absent or when target is session-only.
 */
export function extractOracleName(target: string): string {
  const clean = stripPaneSuffix(target);
  if (!clean) return "";
  const parts = clean.split(":");

  const hasNodePrefix = parts.length >= 3;
  const sessionPart = hasNodePrefix ? parts[1] : parts[0] || "";
  const windowPart = hasNodePrefix ? parts[2] : parts[1];

  if (windowPart && !/^[0-9]+$/.test(windowPart)) {
    return windowPart.replace(/^\d+-/, "");
  }
  return sessionPart.replace(/^\d+-/, "");
}

function windowNameForTarget(target: string): string | null {
  try {
    const name = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", target, "#{window_name}"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Resolve oracle name for command lookup, querying tmux when window is numeric (#2055).
 */
export function resolveTargetOracle(target: string): string {
  const clean = stripPaneSuffix(target);
  const parts = clean.split(":");
  const hasNodePrefix = parts.length >= 3;
  const session = hasNodePrefix ? parts[1] : parts[0] || "";
  const window = hasNodePrefix ? parts[2] : parts[1];

  const fallback = extractOracleName(target);
  if (!session || !window || !/^\d+$/.test(window) || /^\d+-/.test(session)) return fallback;
  return windowNameForTarget(target) || fallback;
}

/**
 * Strip pane suffixes like `target.0` while preserving dots in window names
 * (e.g. `mawjs-v2`).
 */
function stripPaneSuffix(target: string): string {
  return target.replace(/\.[0-9]+$/, "");
}

function lookupOracleLocalPath(oracleName: string): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".maw", "oracles.json"), "utf-8");
    const data = JSON.parse(raw);
    const normalized = oracleName.replace(/-oracle$/, "");
    const found = data.oracles?.find(
      (o: any) =>
        o.name === oracleName ||
        o.name?.replace(/-oracle$/, "") === normalized ||
        o.repo?.replace(/-oracle$/, "") === normalized ||
        o.repo === oracleName
    );
    return found?.local_path || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical cwd for a tmux target by looking up oracles.json or
 * the fleet config. Used by the WS `wake`/`restart` handlers to `cd` into the
 * intended repo before re-spawning agent — defends against pane cwd
 * drift (manual cd, server reboot, kill+respawn).
 */
export function resolveTargetCwd(target: string): string | null {
  if (!target) return null;
  const clean = stripPaneSuffix(target);
  const parts = clean.split(":");
  const hasNodePrefix = parts.length >= 3;

  const session = hasNodePrefix ? parts[1] : parts[0] || "";
  const winRef = hasNodePrefix ? parts[2] : parts[1];
  if (!session) return null;

  const windowName = windowNameForTarget(target);
  const oracleName = windowName || (winRef && !/^\d+$/.test(winRef) ? winRef : session.replace(/^\d+-/, ""));

  // Check oracles.json direct cache first
  const directPath = lookupOracleLocalPath(oracleName);
  if (directPath) return directPath;

  let fleets;
  try { fleets = loadFleet(); } catch { return null; }

  const fleet = fleets.find(f => f.name === session);
  let win: { name: string; repo?: string } | null | undefined = null;

  if (fleet?.windows?.length) {
    if (windowName) {
      const norm = windowName.replace(/-oracle$/, "");
      win = fleet.windows.find(w => w.name === windowName || w.name.replace(/-oracle$/, "") === norm);
    }
    if (!win && winRef) {
      if (!/^\d+$/.test(winRef)) {
        win = fleet.windows.find(w => w.name === winRef);
      } else {
        win = fleet.windows[parseInt(winRef, 10)];
      }
    }
    if (!win && !winRef) {
      win = fleet.windows[0];
    }
  }

  if (!win && windowName) {
    win = resolveTeamWindow(fleets, target);
  }

  if (!win?.repo) {
    return null;
  }

  const repo = win.repo;
  if (repo.startsWith("github.com/")) {
    return join(getGhqRoot(), repo);
  }
  return join(getGhqRoot(), "github.com", repo);
}

function resolveTeamWindow(fleets: ReturnType<typeof loadFleet>, target: string) {
  const windowName = windowNameForTarget(target);
  if (!windowName) return null;
  const normalizedName = windowName.replace(/-oracle$/, "");
  return fleets
    .flatMap(fleet => fleet.windows)
    .find(window => window.name.replace(/-oracle$/, "") === normalizedName) || null;
}

/**
 * Quote a path for safe inclusion in a shell command. Single-quote wraps
 * the path and escapes embedded single quotes via `'\''`.
 */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
