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
import { appendWorklog, openClaims } from "../worklog/store";
import type { WorklogEntry, WorklogKind } from "../worklog/types";

export type TaskState =
  | "backlog"
  | "todo"
  | "in-progress"
  | "review"
  | "done"
  | "blocked"; // off-flow (ADR 0003 B) — renamed from the dead needs-attention slot

export const TASK_STATES: TaskState[] = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "blocked",
];

/** Linear flow columns (blocked is off-flow — surfaced separately). */
export const TASK_FLOW: TaskState[] = ["backlog", "todo", "in-progress", "review", "done"];

/**
 * Why a card is held off the flow (ADR 0003 B). `dependency` is also the kind
 * the board DERIVES for a card waiting on a parent (Card A) — `block` is the
 * EXPLICIT, human-commanded variant. capability/transient are enum-only for now
 * (no producer yet). `for` routes the decision queue (≠ assignee, who owns work).
 */
export type BlockKind = "dependency" | "needs_input" | "capability" | "transient";
export const BLOCK_KINDS: BlockKind[] = ["dependency", "needs_input", "capability", "transient"];

export interface TaskBlock {
  kind: BlockKind;
  reason?: string;
  for?: string; // "tony" | "<oracle>" | "any" — who must clear it (decision queue)
}

/**
 * Append-only note on a card (kobo-39). The task verbs are all terminal state
 * transitions; a note is the ONLY way the board carries mid-flight truth —
 * an answer to a needs_input block, a decision loopback, a progress line.
 * Principle 1 (Nothing is Deleted): notes are only ever APPENDED, never edited
 * or removed. Each is stamped with author + time (who / when / what).
 */
export interface TaskNote {
  ts: number; // epoch ms (sort key)
  iso: string; // ISO-8601 timestamp
  by: string; // author (oracle / human)
  text: string; // note content (rendered escape-first on the web)
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
  block?: TaskBlock; // set when state = blocked (explicit block — ADR 0003 B)
  prevState?: TaskState; // flow state to return to on unblock
  reviewer?: string; // who should review/take over (set when state = review, optional)
  reviewReason?: string; // why it needs review (optional)
  requestId?: string; // dispatch correlation id — set for auto-created tasks (idempotency key)
  parentIds?: string[]; // card→card deps (ADR 0003 A) — blocked-by-dependency is DERIVED, never stored
  body?: string; // free text: why/detail + markdown checklist (ADR 0003 C) — git-diff'able
  notes?: TaskNote[]; // append-only notes (kobo-39) — mid-flight truth, oldest first, NEVER mutated/deleted
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

/** Read every `*.json` card in a directory (flat, non-recursive). */
function readCardsIn(dir: string): TaskRecord[] {
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
  return out;
}

/**
 * Active cards for a company, newest first (by created ts). Reads the flat
 * tasks/ dir only — the `archive/` SUBDIR is skipped (it isn't a `.json`), so
 * archived done cards drop off the board automatically (ADR 0002 P3).
 */
export function listTasks(company: string): TaskRecord[] {
  return readCardsIn(tasksDir(company)).sort((a, b) => b.ts - a.ts);
}

/** All companies that have a Company Home on this machine (board dirs). */
export function listCompanies(): string[] {
  try {
    return readdirSync(mawDataPath("companies"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Where archived (off-board, still git-tracked) cards live. */
export function archiveDir(company: string): string {
  return mawDataPath("companies", safeSegment(company), "tasks", "archive");
}

export function archivedTaskFilePath(company: string, id: string): string {
  return `${archiveDir(company)}/${safeSegment(id)}.json`;
}

/** Archived cards — moved out of the board but preserved (principle 1). */
export function listArchivedTasks(company: string): TaskRecord[] {
  return readCardsIn(archiveDir(company)).sort((a, b) => b.ts - a.ts);
}

/**
 * Next id `<company>-<n>` — max numeric suffix + 1 across BOTH active and
 * archived cards. Archived ids must still count or a sweep that moves the
 * highest id would let a later add REUSE it (two cards, one id).
 */
export function nextTaskId(company: string): string {
  let max = 0;
  for (const t of [...listTasks(company), ...listArchivedTasks(company)]) {
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
  state?: TaskState; // explicit start state — dispatch passes "in-progress"; manual add omits (→ todo)
  requestId?: string; // dispatch correlation id (auto-create idempotency)
  parentIds?: string[]; // card→card deps (ADR 0003 A) — child is blocked until each parent is done/archived
  body?: string; // free text / markdown checklist (ADR 0003 C)
}

/**
 * Create a card. Default state = todo — a manual `add` records work that has NOT
 * started yet, even when pre-assigned (delegating ahead ≠ starting). Callers that
 * mean "started" (the `maw hey [request:]` dispatch path) pass state explicitly.
 * The assignee picks the work up themselves later via `start`/`claim`.
 */
export function addTask(input: AddTaskInput): TaskRecord {
  const ts = Date.now();
  const assignee = input.assignee ?? null;
  const task: TaskRecord = {
    id: "",
    title: input.title,
    company: input.company,
    state: input.state ?? "todo",
    by: input.by,
    assignee,
    ts,
    updatedTs: ts,
  };
  if (input.dept) task.dept = input.dept;
  if (input.epic) task.epic = input.epic;
  if (input.repo) task.repo = input.repo;
  if (input.requestId) task.requestId = input.requestId;
  if (input.parentIds?.length) task.parentIds = [...new Set(input.parentIds)]; // dedupe, drop if empty
  if (input.body?.length) task.body = input.body;

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

/**
 * Start = the assignee picks their own work up: todo → in-progress. If the card
 * has no assignee yet, the actor becomes it (you started it, you hold it). Emits
 * a `claim` so the open-claims tracker (maw company worklog) shows it's being worked —
 * `done` releases it. Returns null if absent.
 */
export function startTask(company: string, id: string, oracle: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const holder = task.assignee ?? oracle;
  task.assignee = holder;
  task.state = "in-progress";
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, holder, "claim", `started ${task.id}: ${task.title}`);
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

/**
 * PR opened → drive the linked card to review, owned by the PR author, reviewer
 * = the human (eq3-011 kobo-13). Driven by PR-watch off the card.pr link (the
 * SAME link merge→done uses) so the board tracks the PR (truth), not a manual
 * step. Idempotent: a card already review-by-this-author-for-this-reviewer is a
 * no-op, and a done card is never resurrected — so re-polls never churn.
 */
export function prOpenedReview(company: string, id: string, author: string, reviewer = "human"): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.state === "done") return task; // never resurrect a merged/closed card
  if (task.state === "review" && task.assignee === author && task.reviewer === reviewer) return task; // idempotent
  task.state = "review";
  task.assignee = author;
  task.reviewer = reviewer;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, author, "task-review", `review ${task.id}${task.pr ? ` (PR #${task.pr})` : ""} → ${reviewer}: ${task.title}`);
  return task;
}

/** Mark done. `by` is whoever closed it (worker/lead/Tony). Clears review flag. */
export function completeTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const holder = task.assignee; // capture before clearing — the claim is keyed to them
  task.state = "done";
  delete task.reviewer;
  delete task.reviewReason;
  delete task.block; // done auto-clears an explicit block (ADR 0003 B)
  delete task.prevState;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-done", `done ${task.id}: ${task.title}`);
  // Release any open claim the holder left on this card so maw company worklog's open-claims
  // tracker doesn't go stale (handoff fix B). Only when one is actually open — a
  // todo→done or never-claimed card emits no spurious release.
  if (holder && openClaims(task.company).some((c) => c.oracle === holder && (c.task ?? c.summary) === task.id)) {
    emit(task, holder, "claim-release", `release ${task.id}: ${task.title}`);
  }
  return task;
}

/**
 * Append a note to a card (kobo-39) — APPEND-ONLY (principle 1). Never edits or
 * removes an existing note: the prior array is spread into a new one with the
 * note pushed on the end (oldest first). Stamps author + time so the timeline
 * reads who/when/what. Bumps updatedTs (a note IS activity) and emits a
 * `task-note` worklog event. Returns null if the card is absent.
 */
export function noteTask(company: string, id: string, by: string, text: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const note: TaskNote = { ts: Date.now(), iso: nowIso(), by, text };
  task.notes = [...(task.notes ?? []), note]; // append-only — prior notes are untouched
  task.updatedTs = note.ts;
  writeTaskRecord(task);
  const oneLine = text.replace(/\s+/g, " ").trim();
  emit(task, by, "task-note", `note ${task.id}: ${oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine}`);
  return task;
}

export interface BlockInput {
  kind: BlockKind;
  reason?: string;
  for?: string;
}

/**
 * Explicit block (ADR 0003 B) — pull a card OFF the flow and remember where to
 * return. Stores `prevState` (the flow state, only on the first block so a
 * re-block doesn't overwrite it with "blocked") and sets `state = "blocked"` +
 * `block = {kind, reason, for}`. Distinct from Card A's DERIVED dependency block
 * (that one never mutates state). Returns null if the card is absent.
 */
export function blockTask(company: string, id: string, by: string, input: BlockInput): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.state !== "blocked") task.prevState = task.state; // first block remembers the flow state
  task.state = "blocked";
  task.block = { kind: input.kind, ...(input.reason ? { reason: input.reason } : {}), ...(input.for ? { for: input.for } : {}) };
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-blocked", `blocked ${task.id} (${input.kind}${input.for ? ` → ${input.for}` : ""}): ${task.title}`);
  return task;
}

/** Restore a blocked card to its prior flow state (ADR 0003 B). null if absent. */
export function unblockTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.state = task.prevState ?? "todo"; // fall back to todo if somehow unset
  delete task.block;
  delete task.prevState;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-unblocked", `unblocked ${task.id} → ${task.state}: ${task.title}`);
  return task;
}

/** Default board window for done cards (ADR 0002 P3) — tunable per sweep. */
export const DEFAULT_ARCHIVE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Whether a card belongs on the board. Non-done cards always do; a done card
 * only while it's within `days` of being closed. Older done cards age off the
 * board (and a sweep moves them to archive/). `now` is injectable for tests.
 */
export function isOnBoard(task: TaskRecord, days = DEFAULT_ARCHIVE_DAYS, now = Date.now()): boolean {
  if (task.state !== "done") return true;
  const when = task.updatedTs ?? task.ts;
  return when >= now - days * DAY_MS;
}

/**
 * Archive a card: MOVE tasks/<id>.json → tasks/archive/<id>.json (principle 1 —
 * preserved, still git-tracked, never deleted). Off the board, but readable via
 * listArchivedTasks. Returns null if the active card is absent.
 */
export function archiveTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  mkdirSync(archiveDir(company), { recursive: true });
  renameSync(taskFilePath(company, id), archivedTaskFilePath(company, id));
  emit(task, by, "task-archived", `archived ${task.id}: ${task.title}`);
  return task;
}

/**
 * Sweep done cards closed more than `days` ago into archive/ (the cron /
 * clock-out caller, NOT the engine hot-path). Returns the archived cards.
 */
export function archiveOldDone(
  company: string,
  days = DEFAULT_ARCHIVE_DAYS,
  by = "system",
  now = Date.now(),
): TaskRecord[] {
  const archived: TaskRecord[] = [];
  for (const t of listTasks(company)) {
    if (isOnBoard(t, days, now)) continue; // skips non-done + recent done
    const a = archiveTask(company, t.id, by);
    if (a) archived.push(a);
  }
  return archived;
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
 * Derived "needs an owner" block (eq3-011 kobo-14 — Tony's rule: no one doing it
 * → it must show as blocked, not sit silently in todo). A `todo` card with no
 * assignee is off-flow: nobody's on it. Derived at read (like dependency-block),
 * NEVER stored → auto-clears the moment someone is assigned. `backlog` is exempt
 * (intentionally not-ready), and any non-todo state has its own real owner/flow.
 */
export function needsOwner(task: TaskRecord): boolean {
  return task.state === "todo" && !task.assignee;
}

/** Next-action line for an explicitly blocked card — kind + who-clears + why. */
export function blockNextAction(task: TaskRecord): string {
  const b = task.block;
  if (!b) return "⚑ blocked";
  const who = b.for ? ` รอ ${b.for}` : "";
  const why = b.reason ? `: ${b.reason}` : "";
  return `⚑ [${b.kind}]${who}${why}`;
}

/**
 * Next-action hint — the board's answer to "what happens next + who". Computed,
 * never stored. Every state returns a non-empty line so no card is ever a dead
 * end (Track 4 goal). Thai to match the fleet's board copy.
 */
export function taskNextAction(task: TaskRecord): string {
  switch (task.state) {
    case "blocked":
      return blockNextAction(task);
    case "review":
      if (task.pr) return `รอ merge PR #${task.pr} → done`;
      return `รอ ${task.reviewer || "ใครก็ได้"} ตรวจ${task.reviewReason ? ` (${task.reviewReason})` : ""}`;
    case "in-progress":
      if (task.assignee && task.by !== task.assignee) return `${task.by} รอ ${task.assignee}`;
      return task.assignee ? `${task.assignee} กำลังทำ` : "รอคนหยิบ";
    case "todo":
      // assigned todo → waiting on that person to START (was wrongly "รอคนหยิบ");
      // unassigned todo → needs an owner (surfaced off-flow in the Blocked lane).
      return task.assignee ? `รอ ${task.assignee} เริ่ม` : "⚑ ยังไม่มีเจ้าของ — รอ assign";
    case "backlog":
      return "ยังไม่พร้อม (backlog)";
    case "done":
      return "เสร็จแล้ว ✓";
    default:
      return "";
  }
}

/** Parent card's state for dependency resolution: its TaskState, "archived", or null (not found). */
export type ParentState = TaskState | "archived" | null;

export interface DependencyBlock {
  blockedBy: string[]; // parents not yet done/archived → they block the child
  missing: string[]; // parent ids that resolve to nothing → satisfied, but surfaced faintly
}

/**
 * Derived blocked-by-dependency (ADR 0003 A) — computed at board read, NEVER
 * stored (same pattern as wait-for / next-action). 1 hop only: we never traverse
 * a parent's own parents, which keeps it loop-safe by construction. A parent
 * satisfies the child when it's `done` OR `archived`; a parent that can't be
 * resolved counts as satisfied but is reported in `missing` for a faint warning.
 */
export function dependencyBlock(
  task: TaskRecord,
  getParentState: (id: string) => ParentState,
): DependencyBlock {
  const blockedBy: string[] = [];
  const missing: string[] = [];
  for (const p of task.parentIds ?? []) {
    const st = getParentState(p);
    if (st === null) { missing.push(p); continue; } // unknown id → satisfied + warn
    if (st === "done" || st === "archived") continue; // satisfied
    blockedBy.push(p); // a real, not-yet-done parent → blocks
  }
  return { blockedBy, missing };
}

/** True when any parent is still pending (the card is held off the flow). */
export function isBlockedByDependency(
  task: TaskRecord,
  getParentState: (id: string) => ParentState,
): boolean {
  return dependencyBlock(task, getParentState).blockedBy.length > 0;
}

/**
 * Build a parent-state resolver for a company: active card state, "archived" for
 * archived cards, or null when the id matches nothing. Reads active + archived
 * once so a whole board render shares one lookup.
 */
export function parentStateResolver(company: string): (id: string) => ParentState {
  const active = new Map(listTasks(company).map((t) => [t.id, t.state] as const));
  const archived = new Set(listArchivedTasks(company).map((t) => t.id));
  return (id) => active.get(id) ?? (archived.has(id) ? "archived" : null);
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

/**
 * Count GitHub-style markdown checkboxes in a card body (ADR 0003 C) → `N/M`.
 * Matches `- [ ]` / `- [x]` (also `*` bullets, case-insensitive x). Lazy: items
 * carry no id — the body markdown is the source of truth, git-diff'able + hand-
 * editable. Returns null when there's no body or no checkbox at all, so callers
 * simply show no progress badge (never an error on a plain card).
 */
export function checklistProgress(body?: string): ChecklistProgress | null {
  if (!body) return null;
  const re = /^[ \t]*[-*]\s+\[([ xX])\]\s+/gm;
  let done = 0;
  let total = 0;
  for (const m of body.matchAll(re)) {
    total++;
    if (m[1] !== " ") done++;
  }
  return total ? { done, total } : null;
}
