import { execFileSync } from "node:child_process";
import { join } from "path";
import { loadFleet } from "./fleet-load";
import { getGhqRoot } from "../../config/ghq-root";

/**
 * Extract oracle name from a tmux target. Sessions are conventionally
 * `NN-<oracle>` (e.g. `05-nari` → `nari`). The previous extraction
 * (`target.split(":").pop()`) returned the window index/name, which
 * `buildCommand` could not match — falling back to the default command
 * regardless of which oracle was being woken.
 */
export function extractOracleName(target: string): string {
  const session = target?.split(":")[0] || "";
  return session.replace(/^\d+-/, "");
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

export function resolveTargetOracle(target: string): string {
  const [session, window] = target.split(":");
  const fallback = extractOracleName(target);
  if (!session || !window || !/^\d+$/.test(window) || /^\d+-/.test(session)) return fallback;
  return windowNameForTarget(target) || fallback;
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
  const [session, winRef] = target.split(":");
  if (!session) return null;

  let fleets;
  try { fleets = loadFleet(); } catch { return null; }

  const fleet = fleets.find(f => f.name === session);
  const win = !fleet?.windows?.length
    ? resolveTeamWindow(fleets, target, winRef)
    : !winRef
      ? fleet.windows[0]
      : /^\d+$/.test(winRef)
        ? fleet.windows[parseInt(winRef, 10)]
        : fleet.windows.find(w => w.name === winRef);
  if (!win?.repo) return null;

  return join(getGhqRoot(), "github.com", win.repo);
}

function resolveTeamWindow(fleets: ReturnType<typeof loadFleet>, target: string, winRef?: string) {
  if (!winRef || !/^\d+$/.test(winRef)) return null;
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
