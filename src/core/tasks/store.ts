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
  reviewer?: string; // who should review/take over (set when state = review, optional)
  reviewReason?: string; // why it needs review (optional)
  requestId?: string; // dispatch correlation id — set for auto-created tasks (idempotency key)
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

/**
 * Overwrite an EXISTING card atomically — temp file in the same dir, then rename
 * over the target. Used by updates (claim/complete) where the id already exists.
 */
function writeTaskRecord(task: TaskRecord): void {
  const path = taskFilePath(task.company, task.id);
  mkdirSync(tasksDir(task.company), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Create a NEW card, claiming its id atomically via an exclusive open (O_EXCL,
 * the "wx" flag). If a concurrent writer already took this id the open throws
 * EEXIST — we report the collision so the caller can pick the next id and retry.
 * This makes id-allocation race-safe: nextTaskId alone (max+1) is not, because
 * two adds can compute the same id before either writes.
 */
export function tryCreateTaskRecord(task: TaskRecord): boolean {
  const path = taskFilePath(task.company, task.id);
  mkdirSync(tasksDir(task.company), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(task, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; // id taken — caller retries
    throw e;
  }
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
  requestId?: string; // dispatch correlation id (auto-create idempotency)
}

/**
 * Create a card. Default state = todo (ready for pickup). If an assignee is
 * given at creation (delegation — "A hands to B"), it starts in-progress.
 */
export function addTask(input: AddTaskInput): TaskRecord {
  const ts = Date.now();
  const assignee = input.assignee ?? null;
  const task: TaskRecord = {
    id: "",
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
  if (input.requestId) task.requestId = input.requestId;

  // Race-safe id allocation: compute candidate, claim it exclusively; on a
  // collision recompute and retry. Bounded so a pathological loop can't hang.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; ; attempt++) {
    task.id = nextTaskId(input.company);
    if (tryCreateTaskRecord(task)) break;
    if (attempt >= MAX_ATTEMPTS - 1) {
      throw new Error(`task id allocation failed for ${input.company} after ${MAX_ATTEMPTS} attempts (id collisions)`);
    }
  }
  emit(task, input.by, "task-created", `created ${task.id}: ${task.title}`);
  return task;
}

/**
 * Claim = set assignee + move to in-progress (ADR §1). Doubles as the review
 * hand-off exit: a new person claiming a review task takes it back to
 * in-progress. Clears any review flag. Returns null if absent.
 */
export function claimTask(company: string, id: string, oracle: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.assignee = oracle;
  task.state = "in-progress";
  delete task.reviewer;
  delete task.reviewReason;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, oracle, "claim", `claimed ${task.id}: ${task.title}`);
  return task;
}

export interface ReviewInput {
  to?: string; // requested reviewer / next person (optional → anyone)
  reason?: string;
}

/**
 * Move a task into review — "needs another person" to check or hand off (ADR
 * refined). Manual (no PR required). Records who should review (`to`) + why.
 */
export function reviewTask(company: string, id: string, by: string, opts: ReviewInput = {}): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "review";
  if (opts.to) task.reviewer = opts.to; else delete task.reviewer;
  if (opts.reason) task.reviewReason = opts.reason; else delete task.reviewReason;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `review ${task.id}${opts.to ? ` → ${opts.to}` : ""}: ${task.title}`);
  return task;
}

/**
 * Attach a PR to a task and move it to review (the auto path — "done my part,
 * PR up, review me"). PR-watch flips it to done on merge. Returns null if absent.
 */
export function setTaskPr(company: string, id: string, pr: number, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.pr = pr;
  task.state = "review";
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `review ${task.id} (PR #${pr}): ${task.title}`);
  return task;
}

/** Mark done. `by` is whoever closed it (worker/lead/Tony). Clears review flag. */
export function completeTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "done";
  delete task.reviewer;
  delete task.reviewReason;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-done", `done ${task.id}: ${task.title}`);
  return task;
}

/** Find the task in a company carrying this PR number (for PR-watch auto-done). */
export function findTaskByPr(company: string, pr: number): TaskRecord | null {
  return listTasks(company).find((t) => t.pr === pr && t.state !== "done") ?? null;
}

/** Pull a GitHub PR number out of a reply message (…/pull/<n>). null if none. */
export function parsePrNumber(text: string): number | null {
  const m = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i.exec(text);
  return m ? +m[1] : null;
}

/**
 * Next-action hint — the board's answer to "what happens next + who". Computed,
 * never stored. Every state returns a non-empty line so no card is ever a dead
 * end (Track 4 goal). Thai to match the fleet's board copy.
 */
export function taskNextAction(task: TaskRecord): string {
  switch (task.state) {
    case "needs-attention":
      return task.attention
        ? `⚑ ขอ ${task.attention.for}: ${task.attention.reason}`
        : "⚑ ต้องการความช่วยเหลือ";
    case "review":
      if (task.pr) return `รอ merge PR #${task.pr} → done`;
      return `รอ ${task.reviewer || "ใครก็ได้"} ตรวจ${task.reviewReason ? ` (${task.reviewReason})` : ""}`;
    case "in-progress":
      if (task.assignee && task.by !== task.assignee) return `${task.by} รอ ${task.assignee}`;
      return task.assignee ? `${task.assignee} กำลังทำ` : "รอคนหยิบ";
    case "todo":
      return "รอคนหยิบ";
    case "backlog":
      return "ยังไม่พร้อม (backlog)";
    case "done":
      return "เสร็จแล้ว ✓";
    default:
      return "";
  }
}
