import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../../../sdk";
import { cmdTeamTaskList, type MawTask } from "./task-ops";
import { loadTeam } from "./impl";

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

async function getPanes(): Promise<Map<string, string>> {
  const paneMap = new Map<string, string>();
  try {
    const out = await hostExec(
      "tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index} #{pane_current_command}'"
    );
    for (const line of out.split("\n").filter(Boolean)) {
      const [paneId, session, cmd] = line.split(" ");
      if (paneId) paneMap.set(paneId, `${session ?? ""} ${cmd ?? ""}`.trim());
    }
  } catch { /* tmux may not be running */ }
  return paneMap;
}

export async function cmdTeamStatus(teamName?: string): Promise<void> {
  const teams = teamName ? [teamName] : listTeams();

  if (teams.length === 0) {
    console.log(`\x1b[36mℹ\x1b[0m no active teams`);
    return;
  }

  const panes = await getPanes();

  for (const name of teams) {
    const config = loadTeam(name);
    if (!config) {
      console.log(`\x1b[33m⚠\x1b[0m team not found: ${name}`);
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
    console.log(`\n\x1b[36;1mTeam: ${name}\x1b[0m (${members.length} agents)\n`);
    console.log(
      `  ${pad("Agent", 15)} ${pad("Status", 9)} ${pad("Task", 29)} Pane`
    );
    console.log(
      `  ${"─".repeat(15)} ${"─".repeat(9)} ${"─".repeat(29)} ${"─".repeat(8)}`
    );

    let working = 0;
    let idle = 0;

    for (const m of members) {
      const memberTasks = taskByAssignee.get(m.name) ?? [];
      const activeTask = memberTasks.find(t => t.status === "in_progress") ?? memberTasks.at(-1);
      const taskLabel = activeTask
        ? `#${activeTask.id} ${activeTask.subject.slice(0, 20)} [${activeTask.status === "completed" ? "done" : activeTask.status}]`
        : "-";

      const paneId = m.tmuxPaneId ?? "";
      const paneLabel = paneId && panes.has(paneId) ? paneId : (paneId || "-");
      const isWorking = activeTask?.status === "in_progress";
      isWorking ? working++ : idle++;

      const statusTxt = isWorking
        ? `\x1b[36mworking\x1b[0m  `
        : `\x1b[90midle\x1b[0m     `;

      console.log(
        `  ${pad(m.name, 15)} ${statusTxt} ${pad(taskLabel, 29)} ${paneLabel}`
      );
    }

    const done = tasks.filter(t => t.status === "completed").length;
    console.log(
      `\n  \x1b[90mTasks: ${done}/${tasks.length} done | Agents: ${working} working, ${idle} idle\x1b[0m`
    );
  }
  console.log("");
}
