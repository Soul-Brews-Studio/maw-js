import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../../../sdk";
import { cmdTeamTaskList, type MawTask } from "./task-ops";
import { loadTeam } from "./impl";
import { type AgentColor, colorAnsi } from "../tmux/layout-manager";

const TEAMS_DIR = join(homedir(), ".claude/teams");

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function listTeams(): string[] {
  if (!existsSync(TEAMS_DIR)) return [];
  return readdirSync(TEAMS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

async function getAlivePanes(): Promise<Set<string>> {
  try {
    const out = await hostExec("tmux list-panes -a -F '#{pane_id}'");
    return new Set(out.split("\n").filter(Boolean));
  } catch { return new Set(); }
}

export async function cmdTeamStatus(teamName?: string): Promise<void> {
  const teams = teamName ? [teamName] : listTeams();

  if (teams.length === 0) {
    console.log(`\x1b[36minfo\x1b[0m no active teams`);
    return;
  }

  const alive = await getAlivePanes();

  for (const name of teams) {
    const config = loadTeam(name);
    if (!config) {
      console.log(`\x1b[33m!\x1b[0m team not found: ${name}`);
      continue;
    }

    const tasks = cmdTeamTaskList(name);
    const taskByAssignee = new Map<string, MawTask[]>();
    for (const t of tasks) {
      if (t.assignee) {
        const arr = taskByAssignee.get(t.assignee) ?? [];
        arr.push(t);
        taskByAssignee.set(t.assignee, arr);
      }
    }

    const members = config.members.filter(m => m.agentType !== "team-lead");
    console.log(`\n\x1b[36;1m${name}\x1b[0m (${members.length} agents)\n`);
    console.log(
      `  ${pad("Agent", 20)} ${pad("Status", 10)} ${pad("Task", 25)} Pane`
    );
    console.log(
      `  ${"─".repeat(20)} ${"─".repeat(10)} ${"─".repeat(25)} ${"─".repeat(10)}`
    );

    let running = 0;
    let dead = 0;

    for (const m of members) {
      const memberTasks = taskByAssignee.get(m.name) ?? [];
      const activeTask = memberTasks.find(t => t.status === "in_progress") ?? memberTasks.at(-1);
      const taskLabel = activeTask
        ? `#${activeTask.id} ${activeTask.subject.slice(0, 18)} [${activeTask.status === "completed" ? "done" : activeTask.status}]`
        : "\x1b[90m-\x1b[0m";

      const paneId = m.tmuxPaneId ?? "";
      const isAlive = paneId ? alive.has(paneId) : false;
      isAlive ? running++ : dead++;

      const color = (m.color as AgentColor) || "white";
      const ansi = colorAnsi(color);
      const agentId = m.agentId || m.name;

      const dot = isAlive ? `\x1b[${ansi}m●\x1b[0m` : `\x1b[90m·\x1b[0m`;
      const nameCol = isAlive
        ? `\x1b[${ansi}m${pad(agentId, 18)}\x1b[0m`
        : `\x1b[90m${pad(agentId, 18)}\x1b[0m`;
      const statusCol = isAlive
        ? `\x1b[32mrunning\x1b[0m   `
        : `\x1b[90mexited\x1b[0m    `;
      const paneCol = isAlive ? paneId : `\x1b[90m${paneId || "-"}\x1b[0m`;

      console.log(`  ${dot} ${nameCol} ${statusCol} ${pad(taskLabel, 25)} ${paneCol}`);
    }

    const done = tasks.filter(t => t.status === "completed").length;
    console.log(
      `\n  \x1b[90mTasks: ${done}/${tasks.length} done | ${running} running, ${dead} exited\x1b[0m`
    );
  }
  console.log("");
}
