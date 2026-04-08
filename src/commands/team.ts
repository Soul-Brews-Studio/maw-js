import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmux } from "../tmux";
import type { TmuxPane } from "../tmux";
import { loadFleetEntries } from "./fleet-load";

// Exported for testing — override with setTeamsDir/setTasksDir
let TEAMS_DIR = join(homedir(), ".claude/teams");
let TASKS_DIR = join(homedir(), ".claude/tasks");

/** @internal — for tests only */
export function _setDirs(teams: string, tasks: string) {
  TEAMS_DIR = teams;
  TASKS_DIR = tasks;
}

interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  tmuxPaneId?: string;
  color?: string;
  model?: string;
  backendType?: string;
}

interface TeamConfig {
  name: string;
  description?: string;
  members: TeamMember[];
  createdAt?: number;
}

export function loadTeam(name: string): TeamConfig | null {
  const configPath = join(TEAMS_DIR, name, "config.json");
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf-8")); }
  catch { return null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Write a shutdown_request message to a teammate's inbox file.
 * This is the same protocol Claude Code uses internally via SendMessage.
 */
export function writeShutdownRequest(teamName: string, memberName: string, reason: string): void {
  const inboxPath = join(TEAMS_DIR, teamName, "inboxes", `${memberName}.json`);
  let messages: any[] = [];
  if (existsSync(inboxPath)) {
    try { messages = JSON.parse(readFileSync(inboxPath, "utf-8")); } catch { messages = []; }
  }
  const requestId = `shutdown-${Date.now()}@${memberName}`;
  messages.push({
    from: "maw-team-shutdown",
    text: JSON.stringify({ type: "shutdown_request", reason, request_id: requestId }),
    summary: `Shutdown request: ${reason}`,
    timestamp: new Date().toISOString(),
    read: false,
  });
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
}

// ─── A1: maw team shutdown <name> ───

export async function cmdTeamShutdown(name: string, opts: { force?: boolean } = {}) {
  const team = loadTeam(name);
  if (!team) {
    console.error(`\x1b[31m✗\x1b[0m team not found: ${name}`);
    console.error(`  check ~/.claude/teams/ for available teams`);
    process.exit(1);
  }

  const teammates = team.members.filter(m => m.agentType !== "team-lead");
  if (!teammates.length) {
    console.log(`\x1b[90mNo teammates to shut down in '${name}'.\x1b[0m`);
    return;
  }

  const panes = await tmux.listPaneIds();
  const alive = teammates.filter(m =>
    m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && panes.has(m.tmuxPaneId)
  );

  if (!alive.length) {
    console.log(`\x1b[90mAll teammates in '${name}' already exited. Cleaning up config...\x1b[0m`);
    cleanupTeamDir(name);
    return;
  }

  console.log(`\x1b[36m⏳\x1b[0m shutting down ${alive.length} teammate(s) in '${name}'...`);

  // Step 1: Send shutdown_request via inbox files
  for (const m of alive) {
    try {
      writeShutdownRequest(name, m.name, "team teardown via maw team shutdown");
      console.log(`  \x1b[90m↪ shutdown_request → ${m.name} (${m.tmuxPaneId})\x1b[0m`);
    } catch (e) {
      console.error(`  \x1b[31m✗\x1b[0m failed to send shutdown to ${m.name}: ${e}`);
    }
  }

  // Step 2: Wait for panes to die (up to 30s)
  const deadline = Date.now() + 30_000;
  let remaining = alive.length;
  while (Date.now() < deadline && remaining > 0) {
    await sleep(1000);
    const current = await tmux.listPaneIds();
    remaining = alive.filter(m => current.has(m.tmuxPaneId!)).length;
    if (remaining > 0 && Date.now() + 5000 > deadline) break;
  }

  // Step 3: Force-kill stragglers
  const finalPanes = await tmux.listPaneIds();
  for (const m of alive) {
    if (!finalPanes.has(m.tmuxPaneId!)) {
      console.log(`  \x1b[32m✓\x1b[0m ${m.name} shut down gracefully`);
      continue;
    }
    if (opts.force) {
      await tmux.killPane(m.tmuxPaneId!);
      console.log(`  \x1b[33m⚠\x1b[0m force-killed ${m.name} (${m.tmuxPaneId})`);
    } else {
      console.error(`  \x1b[31m✗\x1b[0m ${m.name} did not respond to shutdown_request (use --force to kill)`);
    }
  }

  cleanupTeamDir(name);
  console.log(`\x1b[32m✓\x1b[0m team '${name}' shut down`);
}

function cleanupTeamDir(name: string) {
  const teamDir = join(TEAMS_DIR, name);
  const tasksDir = join(TASKS_DIR, name);
  if (existsSync(teamDir)) { try { rmSync(teamDir, { recursive: true }); } catch {} }
  if (existsSync(tasksDir)) { try { rmSync(tasksDir, { recursive: true }); } catch {} }
}

// ─── A2: maw team list ───

export async function cmdTeamList() {
  let teamDirs: string[] = [];
  try {
    teamDirs = readdirSync(TEAMS_DIR).filter(d =>
      existsSync(join(TEAMS_DIR, d, "config.json"))
    );
  } catch { /* expected: teams dir may not exist */ }

  if (!teamDirs.length) {
    console.log("\x1b[90mNo teams found in ~/.claude/teams/\x1b[0m");
    return;
  }

  const panes = await tmux.listPaneIds();

  console.log();
  console.log(`  \x1b[36;1mTEAM${" ".repeat(26)}MEMBERS  STATUS          ZOMBIES\x1b[0m`);

  for (const dir of teamDirs) {
    const team = loadTeam(dir);
    if (!team) continue;

    const teammates = team.members.filter(m => m.agentType !== "team-lead");
    const aliveMembers = team.members.filter(m =>
      m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && panes.has(m.tmuxPaneId)
    );
    const deadPanes = teammates.filter(m =>
      m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && !panes.has(m.tmuxPaneId)
    );

    const name = dir.padEnd(30);
    const memberCount = String(teammates.length).padEnd(9);
    const idle = aliveMembers.filter(m => m.agentType !== "team-lead").length;
    const status = aliveMembers.length > 0
      ? `\x1b[32m${idle} alive\x1b[0m`.padEnd(26)
      : `\x1b[90mno live panes\x1b[0m`.padEnd(26);

    console.log(`  ${name}${memberCount}${status}${deadPanes.length > 0 ? `\x1b[90m${deadPanes.length} exited\x1b[0m` : "0"}`);
  }

  // Check for orphan zombie panes (panes running claude with no matching team)
  const allPanes = await tmux.listPanes();
  const zombies = findZombiePanes(allPanes);
  if (zombies.length > 0) {
    console.log(`\n  \x1b[33m⚠ ${zombies.length} orphan zombie pane(s) detected\x1b[0m — run \x1b[36mmaw cleanup --zombie-agents\x1b[0m`);
  }

  console.log();
}

// ─── A3: maw cleanup --zombie-agents ───

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
function findZombiePanes(allPanes: TmuxPane[]): ZombiePane[] {
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
  // Also allow the meta-view session `maw-view` which mirrors fleet panes.
  fleetSessions.add("maw-view");

  const isFleetPane = (target: string): boolean => {
    const session = target.split(":")[0];
    return fleetSessions.has(session);
  };

  // Find claude panes that are (a) not in any team config AND (b) not in the fleet
  return allPanes
    .filter(p =>
      p.command?.includes("claude") &&
      !knownTeamPaneIds.has(p.id) &&
      !isFleetPane(p.target)
    )
    .map(p => ({
      paneId: p.id,
      info: `${p.target}  "${(p.title || "").slice(0, 50)}"`,
      teamName: "unknown",
    }));
}
