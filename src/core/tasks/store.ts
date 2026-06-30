/**
 * Task store — file-per-card under the Company Home (ADR 0001 §6):
 *   ~/.maw/companies/<company>/tasks/<id>.json
 *
 * SSoT split (glossary): task *state* lives here (one JSON per card); task
 * *events* go to the worklog append-log. The board reads the directory, so two
 * workers touching two different cards never race. Writes are atomic via
 * temp+rename (mirrors the consent-pending store) so a reader never sees a
 * half-written card.
 *
 * `claim` is a verb here, not an object: claiming sets `assignee` + moves state
 * to in-progress (ADR §1). wait-for is NOT stored — the board derives it.
 *
 * Mutators emit a worklog event so the activity feed stays the single timeline.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { mawDataPath } from "../xdg";
import { appendWorklog } from "../worklog/store";
import type { WorklogEntry, WorklogKind } from "../worklog/types";

export type TaskState =
  | "backlog"
  | "todo"
  | "in-progress"
  | "review"
  | "done"
  | "needs-attention";

export const TASK_STATES: TaskState[] = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "needs-attention",
];

/** Linear flow columns (needs-attention is off-flow — surfaced separately). */
export const TASK_FLOW: TaskState[] = ["backlog", "todo", "in-progress", "review", "done"];

export interface TaskAttention {
  for: string; // "tony" | "<oracle>" | "any" — routing for the decision queue
  reason: string;
}

export interface TaskRecord {
  id: string; // <company>-<n>
  title: string;
  company: string;
  dept?: string;
  epic?: string; // tag, not an entity (glossary)
  state: TaskState;
  by: string; // who created / delegated
  assignee: string | null; // who holds the work (SSoT for ownership)
  repo?: string;
  pr?: number;
  attention?: TaskAttention; // set when state = needs-attention
  ts: number; // created (epoch ms)
  updatedTs?: number; // last mutation (epoch ms)
}

/** company → safe single path segment (no traversal / separators / dots). */
function safeSegment(company: string): string {
  return company.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function tasksDir(company: string): string {
  return mawDataPath("companies", safeSegment(company), "tasks");
}

export function taskFilePath(company: string, id: string): string {
  return mawDataPath("companies", safeSegment(company), "tasks", `${safeSegment(id)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Atomic write — temp file in the same dir, then rename over the target. */
function writeTaskRecord(task: TaskRecord): void {
  const path = taskFilePath(task.company, task.id);
  mkdirSync(tasksDir(task.company), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readTask(company: string, id: string): TaskRecord | null {
  const path = taskFilePath(company, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskRecord;
  } catch {
    return null;
  }
}

/** All cards for a company, newest first (by created ts). */
export function listTasks(company: string): TaskRecord[] {
  const dir = tasksDir(company);
  if (!existsSync(dir)) return [];
  const out: TaskRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    try {
      out.push(JSON.parse(readFileSync(`${dir}/${file}`, "utf-8")) as TaskRecord);
    } catch {
      /* skip a corrupt/half card — atomic writes should prevent this */
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Next id `<company>-<n>` — max existing numeric suffix + 1. */
export function nextTaskId(company: string): string {
  let max = 0;
  for (const t of listTasks(company)) {
    const m = t.id.match(/-(\d+)$/);
    if (m) max = Math.max(max, +m[1]);
  }
  return `${safeSegment(company)}-${max + 1}`;
}

function emit(task: TaskRecord, oracle: string, kind: WorklogKind, summary: string): void {
  const entry: WorklogEntry = {
    ts: Date.now(),
    iso: nowIso(),
    oracle,
    company: task.company,
    kind,
    summary,
    task: task.id,
  };
  if (task.repo) entry.repo = task.repo;
  if (task.pr) entry.pr = task.pr;
  try {
    appendWorklog(entry);
  } catch {
    /* never let a feed write break a task mutation */
  }
}

export interface AddTaskInput {
  company: string;
  title: string;
  by: string;
  dept?: string;
  epic?: string;
  repo?: string;
  assignee?: string | null;
}

/**
 * Create a card. Default state = todo (ready for pickup). If an assignee is
 * given at creation (delegation — "A hands to B"), it starts in-progress.
 */
export function addTask(input: AddTaskInput): TaskRecord {
  const ts = Date.now();
  const assignee = input.assignee ?? null;
  const task: TaskRecord = {
    id: nextTaskId(input.company),
    title: input.title,
    company: input.company,
    state: assignee ? "in-progress" : "todo",
    by: input.by,
    assignee,
    ts,
    updatedTs: ts,
  };
  if (input.dept) task.dept = input.dept;
  if (input.epic) task.epic = input.epic;
  if (input.repo) task.repo = input.repo;
  writeTaskRecord(task);
  emit(task, input.by, "task-created", `created ${task.id}: ${task.title}`);
  return task;
}

/** Claim = set assignee + move to in-progress (ADR §1). Returns null if absent. */
export function claimTask(company: string, id: string, oracle: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.assignee = oracle;
  task.state = "in-progress";
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, oracle, "claim", `claimed ${task.id}: ${task.title}`);
  return task;
}

/** Mark done. `by` is whoever closed it (worker/lead/Tony). */
export function completeTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "done";
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-done", `done ${task.id}: ${task.title}`);
  return task;
}
