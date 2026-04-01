import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmux } from "../tmux";
import type { MawWS } from "../types";

interface TeamData {
  name: string;
  description: string;
  members: any[];
  tasks: any[];
  alive: boolean;
}

const TEAMS_DIR = join(homedir(), ".claude/teams");
const TASKS_DIR = join(homedir(), ".claude/tasks");

/** Get all live tmux pane IDs (async via tmux abstraction) */
async function livePaneIds(): Promise<Set<string>> {
  try {
    const raw = await tmux.run("list-panes", "-a", "-F", "#{pane_id}");
    return new Set(raw.split("\n").filter(Boolean));
  } catch { return new Set(); }
}

/** Check if a team has any alive members */
function isTeamAlive(members: any[], panes: Set<string>): boolean {
  for (const m of members) {
    // tmux-mode: check if pane exists
    if (m.backendType === "tmux" && m.tmuxPaneId && panes.has(m.tmuxPaneId)) return true;
    // in-process: check if cwd is on this machine (not /Users/ on a Linux box)
    if (m.backendType === "in-process" && m.cwd) {
      const isLocal = m.cwd.startsWith(homedir());
      if (!isLocal) continue; // remote/MBA leftover
      // Check if lead's Claude session might still be running (heuristic: created < 2h ago)
      if (m.joinedAt && Date.now() - m.joinedAt < 2 * 60 * 60 * 1000) return true;
    }
    // team-lead with empty paneId: check by cwd locality + recency
    if (m.agentType === "team-lead" || m.name === "team-lead") {
      if (m.cwd && m.cwd.startsWith(homedir()) && m.joinedAt && Date.now() - m.joinedAt < 2 * 60 * 60 * 1000) return true;
    }
  }
  return false;
}

/** Scan all teams + tasks, return current state with liveness */
export async function scanTeams(): Promise<TeamData[]> {
  try {
    const dirs = readdirSync(TEAMS_DIR).filter(d =>
      existsSync(join(TEAMS_DIR, d, "config.json"))
    );
    const panes = await livePaneIds();
    return dirs.map(d => {
      try {
        const config = JSON.parse(readFileSync(join(TEAMS_DIR, d, "config.json"), "utf-8"));
        const tasksDir = join(TASKS_DIR, d);
        let tasks: any[] = [];
        try {
          tasks = readdirSync(tasksDir)
            .filter(f => f.endsWith(".json"))
            .map(f => {
              try { return JSON.parse(readFileSync(join(tasksDir, f), "utf-8")); }
              catch { return null; }
            })
            .filter(Boolean);
        } catch { /* expected: tasks dir may not exist */ }
        const alive = isTeamAlive(config.members || [], panes);
        return { ...config, tasks, alive };
      } catch { return null; }
    }).filter(Boolean) as TeamData[];
  } catch { return []; }
}

/** Broadcast teams to all clients if changed */
export async function broadcastTeams(
  clients: Set<MawWS>,
  lastJson: { value: string },
): Promise<void> {
  if (clients.size === 0) return;
  const teams = await scanTeams();
  const json = JSON.stringify(teams);
  if (json === lastJson.value) return;
  lastJson.value = json;
  const msg = JSON.stringify({ type: "teams", teams });
  for (const ws of clients) ws.send(msg);
}
