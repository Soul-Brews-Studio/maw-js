import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { mawConfigPath, mawStatePath } from "../../../core/xdg";

function tasksDir(team: string): string {
  return mawStatePath("teams", team, "tasks");
}

function legacyTasksDir(team: string): string {
  return mawConfigPath("teams", team, "tasks");
}

function existingTaskDirs(team: string): string[] {
  const primary = tasksDir(team);
  const legacy = legacyTasksDir(team);
  return [primary, legacy]
    .filter((dir, index, dirs) => dirs.indexOf(dir) === index)
    .filter(dir => existsSync(dir));
}

function ensureTasksDir(team: string): string {
  const dir = tasksDir(team);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function counterPath(team: string): string {
  return join(tasksDir(team), "_counter.json");
}

function legacyCounterPath(team: string): string {
  return join(legacyTasksDir(team), "_counter.json");
}

function taskPath(team: string, id: number): string {
  return join(tasksDir(team), `${id}.json`);
}

function legacyTaskPath(team: string, id: number): string {
  return join(legacyTasksDir(team), `${id}.json`);
}

function existingTaskPath(team: string, id: number): string | null {
  const primary = taskPath(team, id);
  if (existsSync(primary)) return primary;
  const legacy = legacyTaskPath(team, id);
  return existsSync(legacy) ? legacy : null;
}

function nextId(team: string): number {
  const p = counterPath(team);
  const readPath = existsSync(p) ? p : legacyCounterPath(team);
  let counter = { next: 1 };
  if (existsSync(readPath)) {
    try { counter = JSON.parse(readFileSync(readPath, "utf-8")); } catch { /**/ }
  }
  const id = counter.next;
  // lgtm[js/file-system-race] — PRIVATE-PATH: counter under ~/.maw/teams/, see docs/security/file-system-race-stance.md
  writeFileSync(p, JSON.stringify({ next: id + 1 }));
  return id;
}

function readTask(team: string, id: number): MawTask | null {
  const p = existingTaskPath(team, id);
  if (!p) return null;
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
  const dirs = existingTaskDirs(team);
  if (dirs.length === 0) {
    console.log(`\x1b[36mℹ\x1b[0m no tasks for team "${team}"`);
    return [];
  }
  const byId = new Map<number, MawTask>();
  for (const dir of [...dirs].reverse()) {
    for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "_counter.json")) {
      try {
        const task = JSON.parse(readFileSync(join(dir, f), "utf-8")) as MawTask;
        byId.set(task.id, task);
      } catch { /**/ }
    }
  }
  const tasks = [...byId.values()];

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
  const paths = [taskPath(team, id), legacyTaskPath(team, id)]
    .filter((path, index, paths) => paths.indexOf(path) === index);
  const found = paths.some(path => existsSync(path));
  if (!found) {
    console.log(`\x1b[33m⚠\x1b[0m task #${id} not found in team "${team}"`);
    return false;
  }
  for (const path of paths) {
    if (existsSync(path)) rmSync(path);
  }
  console.log(`\x1b[32m✓\x1b[0m task #${id} deleted`);
  return true;
}

export function cmdTeamTaskDeleteAll(team: string): void {
  const primary = tasksDir(team);
  const legacy = legacyTasksDir(team);
  if (existsSync(primary)) rmSync(primary, { recursive: true, force: true });
  if (legacy !== primary && existsSync(legacy)) rmSync(legacy, { recursive: true, force: true });
}
