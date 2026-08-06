import { join } from "path";
import { loadFleet } from "./fleet-load";
import { getGhqRoot } from "../../config/ghq-root";

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

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

/**
 * Strip pane suffixes like `target.0` while preserving dots in window names
 * (e.g. `mawjs-v2`).
 */
function stripPaneSuffix(target: string): string {
  return target.replace(/\.[0-9]+$/, "");
}

/**
 * Resolve the canonical cwd for a tmux target by looking up the fleet
 * config. Used by the WS `wake`/`restart` handlers to `cd` into the
 * intended repo before re-spawning claude — defends against pane cwd
 * drift (manual cd, server reboot, kill+respawn) which causes claude
 * to load the wrong CLAUDE.md and present the wrong oracle identity.
 *
 * Returns null when the session is not fleet-managed or lookup fails;
 * the caller falls back to bare cmd (matches pre-fix behavior).
 */
export function resolveTargetCwd(target: string): string | null {
  if (!target) return null;
  const clean = stripPaneSuffix(target);
  const parts = clean.split(":");
  const hasNodePrefix = parts.length >= 3;

  const session = hasNodePrefix ? parts[1] : parts[0] || "";
  const winRef = hasNodePrefix ? parts[2] : parts[1];
  if (!session) return null;

  let fleets;
  try { fleets = loadFleet(); } catch { return null; }

  const fleet = fleets.find(f => f.name === session);
  if (!fleet?.windows?.length) return null;

  const win = !winRef
    ? fleet.windows[0]
    : /^\d+$/.test(winRef)
      ? fleet.windows[parseInt(winRef, 10)]
      : fleet.windows.find(w => w.name === winRef);
  if (!win?.repo) return null;

  return toPosixPath(join(getGhqRoot(), win.repo));
}

/**
 * Quote a path for safe inclusion in a shell command. Single-quote wraps
 * the path and escapes embedded single quotes via `'\''`.
 */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
