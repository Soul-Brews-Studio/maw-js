import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function configBase(): string {
  return process.env.MAW_CONFIG_DIR ?? join(homedir(), ".config/maw");
}

function tasksDir(team: string): string {
  return join(configBase(), "teams", team, "tasks");
}

function ensureTasksDir(team: string): string {
  const dir = tasksDir(team);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function counterPath(team: string): string {
  return join(tasksDir(team), "_counter.json");
}

function taskPath(team: string, id: number): string {
  return join(tasksDir(team), `${id}.json`);
}

function nextId(team: string): number {
  const p = counterPath(team);
  let counter = { next: 1 };
  if (existsSync(p)) {
    try { counter = JSON.parse(readFileSync(p, "utf-8")); } catch { /**/ }
  }
  const id = counter.next;
  // lgtm[js/file-system-race] — PRIVATE-PATH: counter under ~/.maw/teams/, see docs/security/file-system-race-stance.md
  writeFileSync(p, JSON.stringify({ next: id + 1 }));
  return id;
}

function readTask(team: string, id: number): MawTask | null {
  const p = taskPath(team, id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function writeTask(team: string, task: MawTask): void {
  writeFileSync(taskPath(team, task.id), JSON.stringify(task, null, 2));
}

export interface MawTask {
  id: number;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  assignee?: string;
  createdAt: string;
  updatedAt: string;
}

export function cmdTeamTaskAdd(
  team: string,
  subject: string,
  opts?: { description?: string; assign?: string },
): MawTask {
  ensureTasksDir(team);
  const now = new Date().toISOString();
  const task: MawTask = {
    id: nextId(team),
    subject,
    ...(opts?.description ? { description: opts.description } : {}),
    status: "pending",
    ...(opts?.assign ? { assignee: opts.assign } : {}),
    createdAt: now,
    updatedAt: now,
  };
  writeTask(team, task);
  console.log(`\x1b[32m✓\x1b[0m task #${task.id} created: ${subject}`);
  return task;
}

export function cmdTeamTaskList(team: string): MawTask[] {
  const dir = tasksDir(team);
  if (!existsSync(dir)) {
    console.log(`\x1b[36mℹ\x1b[0m no tasks for team "${team}"`);
    return [];
  }
  const tasks: MawTask[] = readdirSync(dir)
    .filter(f => f.endsWith(".json") && f !== "_counter.json")
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf-8")) as MawTask; } catch { return null; }
    })
    .filter(Boolean) as MawTask[];

  tasks.sort((a, b) => a.id - b.id);

  if (tasks.length === 0) {
    console.log(`\x1b[36mℹ\x1b[0m no tasks for team "${team}"`);
    return tasks;
  }

  const statusColor = (s: string) =>
    s === "completed" ? `\x1b[32m${s}\x1b[0m`
    : s === "in_progress" ? `\x1b[36m${s}\x1b[0m`
    : `\x1b[33m${s}\x1b[0m`;

  console.log(`\x1b[36mℹ\x1b[0m tasks for team "${team}" (${tasks.length}):`);
  for (const t of tasks) {
    const assignee = t.assignee ? ` → ${t.assignee}` : "";
    console.log(`  #${t.id}  [${statusColor(t.status)}]  ${t.subject}${assignee}`);
  }
  return tasks;
}

export function cmdTeamTaskDone(team: string, id: number): MawTask | null {
  ensureTasksDir(team);
  const task = readTask(team, id);
  if (!task) {
    console.log(`\x1b[33m⚠\x1b[0m task #${id} not found in team "${team}"`);
    return null;
  }
  task.status = "completed";
  task.updatedAt = new Date().toISOString();
  writeTask(team, task);
  console.log(`\x1b[32m✓\x1b[0m task #${id} marked completed`);
  return task;
}

export function cmdTeamTaskAssign(team: string, id: number, agent: string): MawTask | null {
  ensureTasksDir(team);
  const task = readTask(team, id);
  if (!task) {
    console.log(`\x1b[33m⚠\x1b[0m task #${id} not found in team "${team}"`);
    return null;
  }
  task.assignee = agent;
  task.status = "in_progress";
  task.updatedAt = new Date().toISOString();
  writeTask(team, task);
  console.log(`\x1b[32m✓\x1b[0m task #${id} assigned to ${agent}`);
  return task;
}

export function cmdTeamTaskDelete(team: string, id: number): boolean {
  const p = taskPath(team, id);
  if (!existsSync(p)) {
    console.log(`\x1b[33m⚠\x1b[0m task #${id} not found in team "${team}"`);
    return false;
  }
  rmSync(p);
  console.log(`\x1b[32m✓\x1b[0m task #${id} deleted`);
  return true;
}

export function cmdTeamTaskDeleteAll(team: string): void {
  const dir = tasksDir(team);
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}
