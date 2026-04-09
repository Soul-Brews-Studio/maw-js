import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmux } from "../tmux";

const TEAMS_DIR = join(homedir(), ".claude/teams");
const TASKS_DIR = join(homedir(), ".claude/tasks");

interface TeamMember {
  name: string;
  color?: string;
  model?: string;
  agentType?: string;
  tmuxPaneId?: string;
  backendType?: string;
}

interface TeamConfig {
  name: string;
  description: string;
  members: TeamMember[];
  createdAt?: number;
}

interface TaskItem {
  id: string;
  subject: string;
  status: string;
  owner?: string;
}

async function livePaneIds(): Promise<Set<string>> {
  return tmux.listPaneIds();
}

function loadTeam(name: string): TeamConfig | null {
  const configPath = join(TEAMS_DIR, name, "config.json");
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf-8")); }
  catch { return null; }
}

function loadTasks(teamName: string): TaskItem[] {
  const dir = join(TASKS_DIR, teamName);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => { try { return JSON.parse(readFileSync(join(dir, f), "utf-8")); } catch { return null; } })
      .filter(Boolean) as TaskItem[];
  } catch { return []; }
}

function colorCode(color?: string): string {
  const map: Record<string, string> = {
    blue: "\x1b[34m", green: "\x1b[32m", red: "\x1b[31m",
    yellow: "\x1b[33m", purple: "\x1b[35m", cyan: "\x1b[36m",
    orange: "\x1b[38;5;208m", pink: "\x1b[38;5;205m",
  };
  return map[color || ""] || "\x1b[90m";
}

function modelShort(model?: string): string {
  if (!model) return "?";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  if (model === "inherit") return "inherit";
  return model.split("-").pop() || model;
}

/** maw mega status — show hierarchy tree */
export async function cmdMegaStatus() {
  const panes = await livePaneIds();

  // Find all mega-* teams
  let teamDirs: string[] = [];
  try {
    teamDirs = readdirSync(TEAMS_DIR).filter(d =>
      existsSync(join(TEAMS_DIR, d, "config.json"))
    );
  } catch { /* expected: teams dir may not exist */ }

  if (!teamDirs.length) {
    console.log("\x1b[90mNo teams found. Use /mega-agent or TeamCreate to start.\x1b[0m");
    return;
  }

  let totalMembers = 0;
  let totalAlive = 0;

  for (const dir of teamDirs) {
    const team = loadTeam(dir);
    if (!team) continue;

    const tasks = loadTasks(dir);
    const done = tasks.filter(t => t.status === "completed").length;
    const lead = team.members.find(m => m.name === "team-lead" || m.agentType === "team-lead");
    const teammates = team.members.filter(m => m !== lead);

    // Check alive
    const hasLivePane = team.members.some(m =>
      m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && panes.has(m.tmuxPaneId)
    );
    const alive = hasLivePane || (team.createdAt && Date.now() - team.createdAt < 2 * 60 * 60 * 1000);
    const status = alive ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";

    totalMembers += team.members.length;
    if (alive) totalAlive++;

    // Header
    console.log(`\n${status} \x1b[36;1m${team.name.toUpperCase()}\x1b[0m${alive ? "" : " \x1b[90m(stale)\x1b[0m"}`);
    if (team.description) console.log(`  \x1b[90m${team.description}\x1b[0m`);
    if (tasks.length > 0) console.log(`  \x1b[90m${done}/${tasks.length} tasks\x1b[0m`);

    // Lead
    if (lead) {
      console.log(`  ├── \x1b[34m●\x1b[0m team-lead \x1b[90m(${modelShort(lead.model)})\x1b[0m`);
    }

    // Teammates
    for (let i = 0; i < teammates.length; i++) {
      const m = teammates[i];
      const isLast = i === teammates.length - 1;
      const prefix = isLast ? "└──" : "├──";
      const cc = colorCode(m.color);
      const paneAlive = m.tmuxPaneId && panes.has(m.tmuxPaneId);
      const paneStatus = paneAlive ? "\x1b[32m●\x1b[0m" : `${cc}●\x1b[0m`;

      let info = `${cc}${m.name}\x1b[0m \x1b[90m(${modelShort(m.model)})\x1b[0m`;
      if (m.backendType) info += ` \x1b[90m[${m.backendType === "in-process" ? "in-proc" : m.backendType}]\x1b[0m`;

      console.log(`  ${prefix} ${paneStatus} ${info}`);
    }

    // Tasks
    if (tasks.length > 0) {
      console.log(`  \x1b[90m─── tasks ───\x1b[0m`);
      for (const t of tasks) {
        const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
        const owner = t.owner ? ` \x1b[90m@${t.owner}\x1b[0m` : "";
        const style = t.status === "completed" ? "\x1b[90m\x1b[9m" : "\x1b[0m";
        console.log(`      ${icon} ${style}${t.subject}\x1b[0m${owner}`);
      }
    }
  }

  console.log(`\n\x1b[90m${totalAlive} alive · ${teamDirs.length - totalAlive} stale · ${totalMembers} agents total\x1b[0m\n`);
}

/** maw mega stop — graceful shutdown all teams */
export async function cmdMegaStop() {
  let teamDirs: string[] = [];
  try {
    teamDirs = readdirSync(TEAMS_DIR).filter(d =>
      existsSync(join(TEAMS_DIR, d, "config.json"))
    );
  } catch { /* expected: teams dir may not exist */ }

  const alive = teamDirs.filter(d => {
    const team = loadTeam(d);
    if (!team) return false;
    return team.createdAt && Date.now() - team.createdAt < 2 * 60 * 60 * 1000;
  });

  if (!alive.length) {
    console.log("\x1b[90mNo active teams to stop.\x1b[0m");
    return;
  }

  console.log(`\x1b[33m⚠\x1b[0m  Stopping ${alive.length} team(s)...`);
  console.log(`\x1b[90m(Use TeamDelete in Claude Code to clean up, or delete ~/.claude/teams/<name>/ manually)\x1b[0m\n`);

  for (const dir of alive) {
    const team = loadTeam(dir);
    if (!team) continue;
    console.log(`  \x1b[31m■\x1b[0m ${team.name} (${team.members.length} members)`);

    // Kill tmux panes
    const panes = await livePaneIds();
    for (const m of team.members) {
      if (m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && panes.has(m.tmuxPaneId)) {
        await tmux.killPane(m.tmuxPaneId);
        console.log(`    \x1b[90mkilled pane ${m.tmuxPaneId} (${m.name})\x1b[0m`);
      }
    }
  }

  console.log(`\n\x1b[32m✓\x1b[0m Panes killed. Run \x1b[36mmaw mega status\x1b[0m to verify.`);
}
