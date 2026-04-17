import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmux } from "../../../sdk";
import type { TmuxPane } from "../../../sdk";
import { loadFleetEntries } from "../../shared/fleet-load";
import { TEAMS_DIR, loadTeam } from "./team-helpers";

// ─── maw cleanup --zombie-agents ───

export async function cmdCleanupZombies(opts: { yes?: boolean } = {}) {
  console.log("\x1b[36mScanning tmux panes...\x1b[0m");

  const allPanes = await tmux.listPanes();
  const zombies = findZombiePanes(allPanes);

  if (!zombies.length) {
    console.log("\x1b[32m✓\x1b[0m No zombie agent panes found.");
    return;
  }

  console.log(`\nFound \x1b[33m${zombies.length}\x1b[0m orphan claude pane(s):\n`);
  for (const z of zombies) {
    console.log(`  \x1b[33m${z.paneId}\x1b[0m  ${z.info}  \x1b[90m(team: ${z.teamName} — DELETED)\x1b[0m`);
  }

  if (!opts.yes) {
    console.log(`\nRun with \x1b[36m--yes\x1b[0m to kill them.`);
    return;
  }

  for (const z of zombies) {
    await tmux.killPane(z.paneId);
    console.log(`\x1b[32m✓\x1b[0m killed ${z.paneId}`);
  }
}

interface ZombiePane {
  paneId: string;
  info: string;
  teamName: string;
}

/**
 * Find zombie panes: tmux panes running `claude` that are NOT part of any
 * live team config AND NOT part of the fleet. Fleet-exclusion is critical
 * — without it, every live fleet oracle would be flagged as a zombie.
 */
export function findZombiePanes(allPanes: TmuxPane[]): ZombiePane[] {
  // Get all known team pane IDs from existing team configs
  const knownTeamPaneIds = new Set<string>();
  let teamDirs: string[] = [];
  try {
    teamDirs = readdirSync(TEAMS_DIR).filter(d =>
      existsSync(join(TEAMS_DIR, d, "config.json"))
    );
  } catch { /* no teams dir */ }

  for (const dir of teamDirs) {
    const team = loadTeam(dir);
    if (!team) continue;
    for (const m of team.members) {
      if (m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "") {
        knownTeamPaneIds.add(m.tmuxPaneId);
      }
    }
  }

  // Compute the set of fleet session names (e.g. "01-pulse", "08-mawjs").
  // Any pane whose target starts with "<fleet-session>:" is a live fleet
  // oracle and must NEVER be flagged as a zombie.
  const fleetSessions = new Set<string>();
  try {
    for (const entry of loadFleetEntries()) {
      fleetSessions.add(entry.file.replace(/\.json$/, ""));
    }
  } catch { /* no fleet dir */ }

  // Also allow meta-view sessions (maw-view + any *-view) which mirror fleet
  // panes. Each oracle creates its meta-view as `<stem>-view` (e.g.
  // mawjs-view, mawui-view). #393 Bug F — zombie-auditor iter3 caught this:
  // hardcoding only "maw-view" left every oracle's live pane one keystroke
  // away from being killed by `maw cleanup --zombie-agents --yes`.
  const isViewSession = (s: string) => s === "maw-view" || /-view$/.test(s);

  // Defense-in-depth: also compute the set of pane ids that have ANY fleet
  // (or view) listing. If the same pane id appears across multiple sessions
  // (tmux-linked windows), a single safe target is enough to mark it safe.
  // This protects against tmux reporting the non-fleet session as canonical.
  const safePaneIds = new Set<string>();
  for (const p of allPanes) {
    const session = p.target.split(":")[0];
    if (fleetSessions.has(session) || isViewSession(session)) {
      safePaneIds.add(p.id);
    }
  }

  const isFleetPane = (target: string): boolean => {
    const session = target.split(":")[0];
    return fleetSessions.has(session) || isViewSession(session);
  };

  // Find claude panes that are (a) not in any team config AND
  // (b) not in the fleet/view (by either target OR any other listing of the same pane)
  return allPanes
    .filter(p =>
      p.command?.includes("claude") &&
      !knownTeamPaneIds.has(p.id) &&
      !isFleetPane(p.target) &&
      !safePaneIds.has(p.id)
    )
    .map(p => ({
      paneId: p.id,
      info: `${p.target}  "${(p.title || "").slice(0, 50)}"`,
      teamName: "unknown",
    }));
}
