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
import { appendWorklog, openClaims, readWorklog } from "../worklog/store";
import type { WorklogEntry, WorklogKind } from "../worklog/types";
import { notifyParentOfSubcardDone } from "./notify";

export type TaskState =
  | "backlog"
  | "todo"
  | "ready" // deps cleared, actionable (kobo-133) — auto-promoted from todo when all parentIds are done/archived
  | "in-progress"
  | "review"
  | "need-answer" // kobo-218 — Tony's DECISION queue ("จะเอายังไง"), off-flow; distinct from approve (yes/no gate) and blocked (waiting on another card)
  | "approve" // kobo-189 — human gate between review (worker-checked) and done (merged)
  | "done"
  | "rejected" // terminal disposition (kobo-101) — "done but not accepted", parallel to done
  | "blocked"; // off-flow (ADR 0003 B) — renamed from the dead needs-attention slot

export const TASK_STATES: TaskState[] = [
  "backlog",
  "todo",
  "ready",
  "in-progress",
  "review",
  "need-answer",
  "approve",
  "done",
  "rejected",
  "blocked",
];

// Linear flow columns. Both `need-answer` (kobo-218) and `blocked` are OFF-flow
// Tony/dependency detours — surfaced as their own lanes, never a progression step.
export const TASK_FLOW: TaskState[] = ["backlog", "todo", "ready", "in-progress", "review", "approve", "done"];

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
  captured?: boolean; // kobo-229: auto-captured from a hey card-id mention (not deliberately authored) — shows on the card but never auto-advances state (mention ≠ work)
}

/**
 * Threaded comment on a card (kobo-140, Phase C). The 4-way split (Board Truth
 * rule 10): a NOTE logs event/evidence (append-only, no questions); a COMMENT is
 * the ask/answer channel — it threads (`replyTo`), resolves (`resolved`), and
 * carries @mentions. The mentions queue reads UNRESOLVED comments with an @ (not
 * notes anymore). Like notes, comments are never edited/deleted (Principle 1);
 * `resolve` only FLIPS the flag (the text stays). `id` is a per-card stable key
 * (`c<n>`, append order) so a reply/resolve can target one comment without ts
 * collisions (the kobo-126 flake).
 */
export interface TaskComment {
  id: string; // per-card stable id "c<n>" — reply/resolve target
  ts: number; // epoch ms (sort key)
  iso: string; // ISO-8601 timestamp
  by: string; // author (oracle / human)
  text: string; // comment content (rendered escape-first on the web)
  replyTo?: string; // parent comment id — a reply in the thread (kobo-140)
  resolved?: boolean; // answered/closed — clears it from the mentions queue
  resolvedBy?: string; // who resolved it
  resolvedTs?: number; // when (epoch ms)
  fromNote?: number; // origin note ts when copied from a question-note (kobo-142 migration) — idempotency marker + provenance
}

/** Card role (kobo-45). `epic` = a container card; children point up to it via
 * the `epic` field. Absent/`task` = a normal card. epic is NOT a new entity — it
 * reuses TaskRecord, so it gets timeline/comment/state for free (spec). */
export type TaskKind = "epic" | "task";

export interface TaskRecord {
  id: string; // <company>-<n>
  title: string;
  company: string;
  dept?: string;
  kind?: TaskKind; // "epic" = container card; absent/"task" = normal card (kobo-45)
  epic?: string; // CONTAINMENT parent — the card id this one lives under (epic→task
  //              →subtask, one mechanism; kobo-45). Unresolvable id → rendered as a
  //              plain tag (backward-compat with pre-containment cards). This is a
  //              DIFFERENT axis from parentIds[] deps below: containment = "lives
  //              under", dependency = "waits for". Set via setTaskEpic (loop-guarded).
  state: TaskState;
  by: string; // who created / delegated
  assignee: string | null; // who holds the work (SSoT for ownership)
  repo?: string;
  pr?: number;
  block?: TaskBlock; // set when state = blocked (explicit block — ADR 0003 B)
  prevState?: TaskState; // flow state to return to on unblock
  reviewer?: string; // who should review/take over (set when state = review, optional)
  reviewReason?: string; // why it needs review (optional)
  rejectReason?: string; // why the card was rejected (kobo-101) — MANDATORY on reject, kept to learn (Nothing is Deleted)
  requestId?: string; // dispatch correlation id — set for auto-created tasks (idempotency key)
  parentIds?: string[]; // card→card deps (ADR 0003 A) — blocked-by-dependency is DERIVED, never stored
  body?: string; // free text: why/detail + markdown checklist (ADR 0003 C) — git-diff'able
  notes?: TaskNote[]; // append-only notes (kobo-39) — mid-flight truth, oldest first, NEVER mutated/deleted
  comments?: TaskComment[]; // threaded ask/answer comments (kobo-140) — resolve flips a flag, never deleted
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
  kind?: TaskKind; // "epic" for a container card (kobo-45) — omit for a normal task
  epic?: string; // containment parent card id (kobo-45) — the "+subtask" path sets this
  repo?: string;
  assignee?: string | null;
  state?: TaskState; // explicit start state — dispatch passes "in-progress"; manual add omits (→ todo)
  requestId?: string; // dispatch correlation id (auto-create idempotency)
  parentIds?: string[]; // card→card deps (ADR 0003 A) — child is blocked until each parent is done/archived
  body?: string; // free text / markdown checklist (ADR 0003 C)
  reviewer?: string; // kobo-144: persistent per-card reviewer (resolve chain head)
  reviewReason?: string; // kobo-218: born-in-approve deploy-approval card carries WHY (the Approve lane invariant — every card says why it's in Tony's queue)
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
  if (input.kind && input.kind !== "task") task.kind = input.kind; // only persist "epic" — task is the default
  if (input.epic) task.epic = input.epic; // a fresh id can't be its own ancestor → no loop possible at create
  if (input.repo) task.repo = input.repo;
  if (input.requestId) task.requestId = input.requestId;
  if (input.parentIds?.length) task.parentIds = [...new Set(input.parentIds)]; // dedupe, drop if empty
  if (input.body?.length) task.body = input.body;
  if (input.reviewer) task.reviewer = input.reviewer; // kobo-144: persistent per-card reviewer
  if (input.reviewReason) task.reviewReason = input.reviewReason; // kobo-218: born-in-approve card's WHY

  // kobo-133/223: born blocked-or-ready. A card that opens with deps → if any
  // parent is still pending it's born BLOCKED (state=blocked, kind=dependency —
  // real state, not a derived overlay; prevState remembers the flow lane to
  // return to, kobo-223). If all deps are already done/archived it skips straight
  // to `ready` (the parent-done promote already fired before this card existed).
  if (task.parentIds?.length && (task.state === "todo" || task.state === "in-progress" || task.state === "ready")) {
    const resolve = parentStateResolver(input.company);
    if (dependencyBlock(task, resolve).blockedBy.length) {
      task.prevState = task.state; // remember where to return (todo default / in-progress dispatch)
      task.state = "blocked";
      task.block = { kind: "dependency" };
    } else if (task.state === "todo") {
      task.state = "ready"; // deps all clear at birth
    }
  }

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
 * Assign = set a card's assignee to `to`. `by` stays the real actor — no
 * impersonation. State is untouched. Returns null if absent.
 *
 * kobo-219 — reassign is friction (deliberate), not a casual move. Displacing an
 * EXISTING owner (`prev && prev !== to`) requires `opts.force` (the CLI's
 * `--force-reassign`); a bare reassign throws {@link ReassignFrictionError}.
 * Rationale (Board Truth rule 9): assignee is the stable true doer — it must not
 * drift by accident. Reassign is for CORRECTION only (wrong-assignee/board-lie
 * fix, e.g. the meganechan→doer reconcile). To hand off PART of the work, create a
 * subtask — the parent keeps its assignee — never reassign the parent. First-assign
 * (null → someone) and idempotent (to === current) need no force: nothing is displaced.
 */
export function assignTask(company: string, id: string, to: string, by: string, opts: { force?: boolean } = {}): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const prev = task.assignee;
  if (prev && prev !== to && !opts.force) {
    throw new ReassignFrictionError(id, prev, to);
  }
  task.assignee = to;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", `assigned ${task.id} → ${to}: ${task.title}`);
  // kobo-211: reassign transfers ownership → free the PREVIOUS holder's claim so the
  // open-claims tracker (⛏) doesn't show the old owner still working (sibling of the
  // kobo-105 done-path fix). We release, never fabricate, a claim: the new assignee's
  // ⛏ appears when they actually start()/claim() — assigning to `human` must not mint a
  // fresh "⛏ human" claim, which is the exact stale badge this is meant to clear.
  releaseAllClaims(task, to);
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

/**
 * Move a card between the flow "parking" states — backlog ⇄ todo (kobo-70) —
 * without the work-pickup semantics of start (no assignee change) or the cleanup
 * of done. The other flow states have dedicated verbs (start→in-progress, review,
 * done); `blocked` has block()/unblock(). Callers (CLI/MCP) restrict `state` to
 * the parking set; the store just records the transition. null if the card is absent.
 */
export function moveTask(company: string, id: string, state: TaskState, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.state = state;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", `moved ${task.id} → ${state}: ${task.title}`);
  return task;
}

/**
 * Edit = reword a card's title/body IN PLACE (kobo-213), keeping the SAME id so
 * the card's whole lineage survives — deps, comment thread, notes, PR link, state
 * and assignee are all untouched. This is a PURE content update: a card id is a
 * sequential `<company>-<n>` counter (nextTaskId), never derived from the wording,
 * and no idempotency/dedup key hashes the title or body — so a reword can't shift
 * any hash (SACRED rule, verified kobo-213). Nothing is Deleted: every changed
 * field appends an audit note carrying the PREVIOUS value, so the old wording
 * stays recoverable in the timeline. No auto-advance (an edit is not "working the
 * card", unlike a note by the assignee). A call that changes nothing is a no-op
 * (returns the card, no audit noise). Returns null if the card is absent.
 */
export function editTask(
  company: string,
  id: string,
  by: string,
  changes: { title?: string; body?: string; reviewer?: string },
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const prev: string[] = [];
  if (typeof changes.title === "string" && changes.title !== task.title) {
    prev.push(`title was: ${task.title}`);
    task.title = changes.title;
  }
  if (typeof changes.body === "string" && changes.body !== (task.body ?? "")) {
    prev.push(`body was:\n${task.body && task.body.length ? task.body : "(empty)"}`);
    task.body = changes.body;
  }
  if (typeof changes.reviewer === "string" && changes.reviewer !== (task.reviewer ?? "")) {
    prev.push(`reviewer was: ${task.reviewer && task.reviewer.length ? task.reviewer : "(unset)"}`);
    task.reviewer = changes.reviewer;
  }
  if (!prev.length) return task; // nothing actually changed — no-op, skip the audit note
  const note: TaskNote = { ts: Date.now(), iso: nowIso(), by, text: `✎ edited — previous values preserved:\n${prev.join("\n")}` };
  task.notes = [...(task.notes ?? []), note]; // append-only audit (Principle 1)
  task.updatedTs = note.ts;
  writeTaskRecord(task);
  emit(task, by, "task-updated", `edited ${task.id}: ${task.title}`);
  return task;
}

/**
 * Resolve who reviews a card (kobo-144, Board Truth rule 12 + kobo-124 addendum) —
 * the chain:
 *   reviewer field  →  creator (`by`)  →  "human"
 * The creator (=requester who knows the AC) reviews by DEFAULT — but is skipped
 * when creator === the doer (assignee): nobody reviews their own work, so it falls
 * through to the human (Tony). This is the SINGLE source of the chain — CLI/MCP/
 * pr-watch all resolve the review target through here so the board never disagrees
 * on "who's up to review this".
 */
export function resolveReviewer(task: TaskRecord): string {
  if (task.reviewer) return task.reviewer;
  if (task.by && task.by !== task.assignee) return task.by; // creator reviews — unless they're the doer
  return "human"; // creator is the doer (self-review banned) → the human
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
  // kobo-144: --to overrides the reviewer, but a plain `review` KEEPS the card's
  // persistent reviewer field (set at add) instead of clearing it — the resolve
  // chain needs that field to survive a review with no explicit --to.
  if (opts.to) task.reviewer = opts.to;
  if (opts.reason) task.reviewReason = opts.reason; else delete task.reviewReason;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `review ${task.id}${opts.to ? ` → ${opts.to}` : ""}: ${task.title}`);
  return task;
}

/**
 * Hold = the reviewer's brake (kobo-144, Board Truth rule 12). Pulls a card into
 * review from ANY state so it can't proceed until looked at — used when the doer
 * is unsure or the change is "big" (money/hash/live-infra/deploy/schema/cross-
 * company). Unlike `review --to` this doesn't reassign the reviewer: the card's
 * persistent reviewer field (or the resolve chain) still names who's up. Records
 * why (`reason`, default "held"). Returns null if absent.
 *
 * kobo-224 — a GATED brake (`opts.gate`) = the reviewer judged this a Tony-gate (big:
 * money/hash/live-infra/deploy/schema/cross-company) card. Route it straight to the
 * approve lane (Tony's decision queue) instead of review — REPLACING the old hold+@tony
 * step so a reviewer's "big → needs Tony" verdict populates Tony's queue by itself
 * (kobo-222 c10). It reuses approveTask verbatim (reason mandatory, enforced there) and
 * NEVER triggers a deploy or any action: approve = queue-for-bless only, Tony bless ≠
 * auto-deploy (deploy stays a human's hand). Pure lane move, no classifier.
 */
export function holdTask(company: string, id: string, by: string, reason?: string, opts: { gate?: boolean } = {}): TaskRecord | null {
  if (opts.gate) return approveTask(company, id, by, reason ?? "");
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "review";
  task.reviewReason = reason || "held";
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `hold ${task.id} → ${resolveReviewer(task)}: ${task.title}`);
  return task;
}

/**
 * Approve = the reviewer routes a BIG-work card (money/hash/live-infra/deploy/
 * schema/cross-company/unsure — Board Truth rule 12) from review → approve, the
 * human gate before done (kobo-189/191). A `reason` is MANDATORY: the Approve lane
 * is Tony's decision queue, so every card in it must say WHY it's there — reuse the
 * reviewReason field (store.ts) so the card-detail + board render it. Returns null
 * on a missing card OR an empty reason (the CLI/API rejects → never a silent park
 * with no reason). Small work never comes here: the reviewer just closes it done.
 * No auto-transition — a reviewer consciously calls this per card (no queue-lie).
 */
export function approveTask(company: string, id: string, by: string, reason: string): TaskRecord | null {
  if (!reason || !reason.trim()) return null; // reason mandatory — no reason, no park
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "approve";
  task.reviewReason = reason.trim();
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `approve ${task.id} → ${resolveReviewer(task)} (${task.reviewReason}): ${task.title}`);
  return task;
}

/**
 * Need-answer = park a card in Tony's DECISION queue (kobo-218) — "จะเอายังไงกับ
 * สิ่งนี้", an OPEN question of direction, distinct from `approve` (a yes/no gate
 * before done) and `blocked` (waiting on another CARD, a dependency). The owner
 * (assignee/reviewer/parent-owner) parks it here instead of the old hold+@tony on
 * the work-card, so Tony's decision queue is its own lane — not buried in review
 * comments or conflated with dependency blocks. A `question` is MANDATORY (the
 * lane is a queue — every card says WHAT it's waiting on); reuse reviewReason so
 * the card-detail + board render it (same field approve uses). The owner MOVES the
 * card back to its next step (existing verbs: start/review/…) once Tony answers —
 * no auto-transition (an answer's next step is Tony's call, not the store's).
 * Assignee is untouched (Board Truth rule 9: the doer stays the owner). Returns
 * null on a missing card OR an empty question.
 */
export function needAnswerTask(company: string, id: string, by: string, question: string): TaskRecord | null {
  if (!question || !question.trim()) return null; // question mandatory — no reason-less park (mirrors approve)
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "need-answer";
  task.reviewReason = question.trim();
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `need-answer ${task.id} → ${resolveReviewer(task)} (${task.reviewReason}): ${task.title}`);
  return task;
}

/**
 * Attach a PR to a task and move it to review (the auto path — "done my part,
 * PR up, review me"). PR-watch flips it to done on merge. Returns null if absent.
 */
export function setTaskPr(company: string, id: string, pr: number, by: string, repo?: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.pr = pr;
  // kobo-80: bind the PR's repo so pr-watch can resolve merge status even when the
  // card was created with no --repo. Only fills a MISSING repo — never overwrites a
  // repo the card already carries. Without this, a repo-less pr card is invisible to
  // openPrLinkedRepos → its merge is never polled → it strands in review (board lie).
  if (repo && !task.repo) task.repo = repo;
  task.state = "review";
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-review", `review ${task.id} (PR #${pr}): ${task.title}`);
  return task;
}

/**
 * Backfill a card's repo IFF it's currently missing — the pr-watch heal path
 * (kobo-80). When a poll flips a repo-less card (found by PR number), we now know
 * the repo it lives in, so record it: the next poll includes the card in
 * openPrLinkedRepos so the merge→done transition is still seen even after the
 * worktree that first surfaced the PR is gone. Silent (no worklog event) — a data
 * repair, not a user action; a no-op once the repo is present (no churn).
 */
export function setTaskRepoIfMissing(company: string, id: string, repo: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.repo || !repo) return task; // already set, or nothing to set → no write
  task.repo = repo;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  return task;
}

/**
 * PR opened → drive the linked card to review (eq3-011 kobo-13). Driven by PR-watch
 * off the card.pr link (the SAME link merge→done uses) so the board tracks the PR
 * (truth), not a manual step. Idempotent: a card already review-for-this-reviewer is
 * a no-op, and a done card is never resurrected — so re-polls never churn.
 *
 * kobo-217 (Board Truth rule 9): the card is NOT reassigned to the PR author. Every
 * agent shares one github account, so the author is a meaningless owner — the real
 * doer (assignee) stays the owner. review-lane + reviewer + the PR link, but the
 * assignee is left exactly as it was.
 *
 * kobo-144 addendum (Tony grill r2): the reviewer is no longer hardcoded to the
 * human. It resolves through the chain — persistent reviewer field → creator (`by`)
 * → human — so by DEFAULT the requester who wrote the AC reviews their own PR,
 * falling to the human only when the creator is the PR author (self-review banned).
 * An explicit `reviewer` arg still overrides (kept for callers/tests that pin it).
 */
export function prOpenedReview(company: string, id: string, author: string, reviewer?: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.state === "done") return task; // never resurrect a merged/closed card
  // kobo-217: the PR author is NOT persisted as the assignee. Every agent opens PRs
  // from one shared github account, so the author is meaningless as an owner —
  // overwriting the real doer made the board lie (Board Truth rule 9: assignee = the
  // stable doer). The doer stays put; the author is used ONLY to resolve the
  // reviewer's self-review guard, and only as a fallback when there's no doer yet.
  const doer = task.assignee ?? author;
  // Reviewer chain (kobo-144): explicit arg wins, else the card's reviewer field,
  // else the creator (unless the creator IS the doer — self-review banned) → human.
  const target = reviewer ?? task.reviewer ?? (task.by && task.by !== doer ? task.by : "human");
  if (task.state === "review" && task.reviewer === target) return task; // idempotent (assignee untouched)
  task.state = "review";
  task.reviewer = target;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, author, "task-review", `review ${task.id}${task.pr ? ` (PR #${task.pr})` : ""} → ${target}: ${task.title}`);
  return task;
}

/**
 * Release EVERY open claim on this card, whoever holds it (kobo-107) — not just
 * the assignee's. A card claimed by A but closed/archived/rejected by B (or when
 * assignee ≠ the claim holder) used to leave A's claim open → stale in maw's
 * open-claims tracker + a false-positive idle-with-work badge (kobo-105). Emits
 * one claim-release per holder; a never-claimed / already-released card emits
 * nothing (openClaims already excludes released ones + dedups per holder).
 *
 * `except` keeps one holder's claim open — used by reassign (kobo-211) to free the
 * PREVIOUS owner's claim while leaving the new assignee's (if any) untouched. Best-
 * effort per node: it releases every claim visible in this company's local ledger
 * (a git-synced foreign claim appears here and is released too). A claim on a node
 * whose ledger hasn't synced in is invisible → nothing to release here (out of scope).
 */
function releaseAllClaims(task: TaskRecord, except?: string): void {
  for (const c of openClaims(task.company)) {
    if ((c.task ?? c.summary) === task.id && c.oracle !== except) {
      emit(task, c.oracle, "claim-release", `release ${task.id}: ${task.title}`);
    }
  }
}

/** Mark done. `by` is whoever closed it (worker/lead/Tony). Clears review flag. */
export function completeTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "done";
  delete task.reviewer;
  delete task.reviewReason;
  delete task.block; // done auto-clears an explicit block (ADR 0003 B)
  delete task.prevState;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-done", `done ${task.id}: ${task.title}`);
  releaseAllClaims(task); // free every claim on this card so open-claims doesn't go stale
  promoteReadyChildren(company, id, by); // kobo-133: this done may open a dependent's gate
  // kobo-135 (B3): an answered ask-subcard finishing pokes its parent's owner (the
  // asker) — replaces eyeballing the parent-badge. Containment axis (epic), so this
  // is a NOTIFY only, never a parent state-flip (pr-watch lesson: auto-flip lies).
  if (task.epic) {
    const parent = readTask(company, task.epic);
    if (parent) notifyParentOfSubcardDone(task, parent, by);
  }
  return task;
}

/**
 * Reject a card (kobo-101) — the "done but NOT accepted" terminal disposition
 * (like closing a PR without merging). Allowed from any NON-terminal state
 * (backlog/todo/in-progress/review/blocked); a done or already-rejected card is
 * terminal, so this is a no-op that returns null so the CLI can report it. The
 * `reason` is MANDATORY (why it wasn't accepted — kept to learn, Nothing is
 * Deleted) and stored in rejectReason. Clears review/block flags and releases any
 * open claim, exactly like completeTask. Returns null if the card is absent OR
 * already terminal.
 */
export function rejectTask(company: string, id: string, by: string, reason: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.state === "done" || task.state === "rejected") return null; // terminal — can't reject
  task.state = "rejected";
  task.rejectReason = reason;
  delete task.reviewer;
  delete task.reviewReason;
  delete task.block; // reject auto-clears an explicit block (mirrors done)
  delete task.prevState;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-rejected", `rejected ${task.id}: ${task.title} — ${reason}`);
  releaseAllClaims(task);
  return task;
}

/**
 * Append a note to a card (kobo-39) — APPEND-ONLY (principle 1). Never edits or
 * removes an existing note: the prior array is spread into a new one with the
 * note pushed on the end (oldest first). Stamps author + time so the timeline
 * reads who/when/what. Bumps updatedTs (a note IS activity) and emits a
 * `task-note` worklog event. Returns null if the card is absent.
 *
 * Auto-advance (kobo-54, board-truth): a note by the card's ASSIGNEE on a `todo`
 * card is unambiguous "I'm working on this" evidence tied to THIS card, so it
 * also flips todo→in-progress (+ a `claim` worklog event, mirroring startTask).
 * Gates keep it from lying (pr-watch rule): only `todo` (backlog stays
 * intentionally not-ready; other states already have an owner/flow), and only
 * when the author IS the assignee — a note by anyone else (e.g. eq3 asking a
 * question on the card) is NOT the doer working, so the card holds. An
 * unassigned card never auto-advances (fall back to explicit `task start`).
 *
 * kobo-229: a CAPTURED note (`opts.captured`) is one auto-captured from a hey that
 * merely mentioned this card-id in chatter — it is stored for the audit trail but
 * NEVER auto-advances (mention ≠ work). Only a deliberately authored note (the real
 * `note` verb, opts.captured falsy) carries the "I'm working on this" signal. This
 * fixes the board-lie where a self-mention flipped an assignee's own todo/ready card
 * to in-progress (kobo-221 finding).
 */
export function noteTask(company: string, id: string, by: string, text: string, opts: { captured?: boolean } = {}): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const note: TaskNote = { ts: Date.now(), iso: nowIso(), by, text, ...(opts.captured ? { captured: true } : {}) };
  task.notes = [...(task.notes ?? []), note]; // append-only — prior notes are untouched
  task.updatedTs = note.ts;
  // A captured mention is never work — only a deliberately authored note advances (kobo-229).
  const advance = !opts.captured && (task.state === "todo" || task.state === "ready") && !!task.assignee && task.assignee === by;
  if (advance) task.state = "in-progress"; // assignee working their own todo/ready card (kobo-54, kobo-133)
  writeTaskRecord(task);
  const oneLine = text.replace(/\s+/g, " ").trim();
  emit(task, by, "task-note", `note ${task.id}: ${oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine}`);
  if (advance) emit(task, by, "claim", `started ${task.id}: ${task.title}`); // open-claims tracker (mirrors startTask)
  return task;
}

/**
 * Add a threaded comment to a card (kobo-140) — the ask/answer channel (Board
 * Truth rule 10). Unlike a note, a comment can be a reply (`replyTo`) and can be
 * resolved. Stamps a per-card stable id (`c<n>`, append order) so replies/resolves
 * target it without ts collisions. Returns null if the card is absent; throws if
 * `replyTo` names a comment that doesn't exist on this card (no dangling threads).
 * Emits a `task-comment` worklog event. @mentions in the text are surfaced by the
 * mentions queue (pendingMentions) until the comment is resolved.
 */
export function commentTask(
  company: string,
  id: string,
  by: string,
  text: string,
  replyTo?: string,
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const existing = task.comments ?? [];
  if (replyTo && !existing.some((c) => c.id === replyTo)) {
    throw new Error(`reply target not found on ${id}: ${replyTo}`);
  }
  const comment: TaskComment = { id: `c${existing.length + 1}`, ts: Date.now(), iso: nowIso(), by, text };
  if (replyTo) comment.replyTo = replyTo;
  task.comments = [...existing, comment]; // append-only — prior comments untouched
  task.updatedTs = comment.ts;
  writeTaskRecord(task);
  const oneLine = text.replace(/\s+/g, " ").trim();
  emit(task, by, "task-comment", `comment ${task.id} (${comment.id}): ${oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine}`);
  return task;
}

/**
 * Resolve a comment (kobo-140) — mark an ask/answer thread closed so it drops out
 * of the mentions queue. FLIPS a flag only (Principle 1: the text is never
 * removed); stamps who/when. Idempotent — resolving an already-resolved comment is
 * a no-op that still returns the card. Returns null if the card is absent; throws
 * if the comment id doesn't exist. Emits a `task-comment` worklog event.
 */
export function resolveComment(company: string, id: string, commentId: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const comment = task.comments?.find((c) => c.id === commentId);
  if (!comment) throw new Error(`comment not found on ${id}: ${commentId}`);
  if (!comment.resolved) {
    comment.resolved = true;
    comment.resolvedBy = by;
    comment.resolvedTs = Date.now();
    task.updatedTs = comment.resolvedTs;
    writeTaskRecord(task);
    emit(task, by, "task-comment", `resolved ${task.id} (${commentId})`);
  }
  return task;
}

export interface CommentMigrateOutcome {
  id: string; // card id
  migrated: number; // question-notes copied to comments this run
  skipped: number; // question-notes already migrated (idempotent)
}
export interface CommentMigrateResult {
  cards: number; // active cards that had question-notes
  migrated: number; // total comments created
  skipped: number; // total already-present (idempotent)
  outcomes: CommentMigrateOutcome[];
}

/**
 * One-shot migration (kobo-142, Phase C C3): copy "question-notes" — notes that
 * carry an @mention, the OLD ask channel — into the comments[] channel (the NEW
 * one, kobo-140), so the repointed mentions queue (which now reads comments) keeps
 * showing the questions that used to live in notes.
 *
 * Rules (per the card):
 *   - ACTIVE cards only — state not done/rejected (archived cards aren't in
 *     listTasks anyway). Closed history is left untouched.
 *   - COPY, never delete — the original note stays (dual-keep: safe rollback,
 *     Principle 1). Only notes with an @mention migrate; plain log-notes stay notes.
 *   - Idempotent — each migrated comment stamps `fromNote` (the origin note ts),
 *     so a re-run skips notes already copied (no duplicates).
 *   - Queue truth preserved — a question-note whose EVERY @mentioned person
 *     replied later on the card (the old "answered" test) migrates as RESOLVED, so
 *     the repointed queue doesn't resurface an already-answered old question.
 *
 * `dryRun` counts what WOULD migrate without writing. Emits one worklog event per
 * card actually changed.
 */
export function migrateQuestionNotesToComments(
  company: string,
  opts: { dryRun?: boolean; by?: string } = {},
): CommentMigrateResult {
  const dryRun = opts.dryRun ?? false;
  const actor = opts.by ?? "system";
  const outcomes: CommentMigrateOutcome[] = [];
  let totalMigrated = 0;
  let totalSkipped = 0;
  let cards = 0;

  for (const task of listTasks(company)) {
    if (task.state === "done" || task.state === "rejected") continue; // active only
    const notes = task.notes ?? [];
    const questionNotes = notes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => parseMentions(n.text).length > 0);
    if (!questionNotes.length) continue;
    cards++;

    const comments = [...(task.comments ?? [])];
    let migrated = 0;
    let skipped = 0;
    for (const { n, i } of questionNotes) {
      // idempotency: this exact note already copied? (ts + author + text)
      if (comments.some((c) => c.fromNote === n.ts && c.by === n.by && c.text === n.text)) {
        skipped++;
        continue;
      }
      const mentions = parseMentions(n.text);
      // old "answered" test: every mentioned person noted AFTER this note on the card
      const answered = mentions.every((who) => notes.slice(i + 1).some((n2) => mentionKey(n2.by) === who));
      const comment: TaskComment = { id: `c${comments.length + 1}`, ts: n.ts, iso: n.iso, by: n.by, text: n.text, fromNote: n.ts };
      if (answered) {
        const replies = notes.slice(i + 1).filter((n2) => mentions.includes(mentionKey(n2.by)));
        const last = replies[replies.length - 1];
        comment.resolved = true;
        comment.resolvedBy = last?.by ?? n.by;
        comment.resolvedTs = last?.ts ?? n.ts;
      }
      comments.push(comment);
      migrated++;
    }

    if (migrated && !dryRun) {
      task.comments = comments;
      task.updatedTs = Date.now();
      writeTaskRecord(task);
      emit(task, actor, "task-comment", `migrated ${migrated} question-note(s) → comments on ${task.id}`);
    }
    totalMigrated += migrated;
    totalSkipped += skipped;
    outcomes.push({ id: task.id, migrated, skipped });
  }

  return { cards, migrated: totalMigrated, skipped: totalSkipped, outcomes };
}

// ── @mentions + ask (kobo-126) ───────────────────────────────────────────────

/**
 * @tony and @human are the SAME person (Tony at the board). Every mention/ask
 * queue collapses them to one canonical key so a note that says "@tony" and a
 * hand-off to "human" land in the same decision queue (head Q3, kobo-126).
 */
const HUMAN_ALIASES = new Set(["tony", "human"]);
export function mentionKey(name: string): string {
  const n = name.trim().toLowerCase().replace(/^@/, "");
  return HUMAN_ALIASES.has(n) ? "tony" : n;
}

/** Distinct @-mentions in a note body, canonicalized (kobo-126). */
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/@([a-z0-9_-]+)/gi)) out.add(mentionKey(m[1]));
  return [...out];
}

export interface PendingMention {
  id: string; // card id the mention is on
  title: string;
  who: string; // canonical mentioned key (e.g. "tony")
  by: string; // who wrote the mentioning comment
  ts: number; // mention comment ts
  iso: string;
  text: string; // the mentioning comment text
  commentId: string; // the comment carrying the mention (resolve target — kobo-140)
}

/**
 * Unanswered @mentions across the on-board cards (kobo-126 → repointed kobo-140).
 * Phase C moved the ask/answer channel from notes to COMMENTS (Board Truth rule
 * 10), so the queue now reads unresolved COMMENTS that carry an @mention — a
 * mention is PENDING until its comment is `resolve`d (explicit, not "someone noted
 * after"). `forWho` filters to one person's queue (canonicalized, so --for tony
 * also catches @human). Read-only derivation — never mutates; both CLI `mentions`
 * and the web queue read this one source.
 */
export function pendingMentions(company: string, forWho?: string): PendingMention[] {
  const want = forWho ? mentionKey(forWho) : null;
  const out: PendingMention[] = [];
  for (const t of listTasks(company)) {
    if (!isOnBoard(t) || !t.comments?.length) continue;
    for (const c of t.comments) {
      if (c.resolved) continue; // resolved thread → out of the queue
      for (const who of parseMentions(c.text)) {
        if (want && who !== want) continue;
        out.push({ id: t.id, title: t.title, who, by: c.by, ts: c.ts, iso: c.iso, text: c.text, commentId: c.id });
      }
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * Ask (kobo-126, ask-Tony 3-tier level 1): a substantive question becomes its own
 * SUBCARD — a real todo assigned to the answerer (default Tony), linked under the
 * parent via containment (epic=parentId) so the parent shows "⧉ open →who" and,
 * when the subcard closes, its owner returns to it. One shot: create + parent +
 * assign. Routes through addTask — the SAME write path as every other card (no
 * parallel writer). Returns null if the parent card doesn't exist.
 */
export function askTask(company: string, parentId: string, question: string, to: string, by: string): TaskRecord | null {
  if (!readTask(company, parentId)) return null; // parent must exist to hang the subcard under
  return addTask({ company, title: question, by, epic: parentId, assignee: mentionKey(to) });
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
  // kobo-223 (3a multi-source): a manual unblock clears the EXPLICIT source, but if a
  // dependency is still pending the card must STAY blocked — reconcile re-enters the
  // dependency block (only when a parent is genuinely still open). No pending dep → the
  // restore above stands.
  reconcileDependencyState(task, parentStateResolver(company));
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
  if (task.state !== "done" && task.state !== "rejected") return true; // rejected is terminal too (kobo-101)
  const when = task.updatedTs ?? task.ts;
  return when >= now - days * DAY_MS;
}

/**
 * Archive a card: MOVE tasks/<id>.json → tasks/archive/<id>.json (principle 1 —
 * preserved, still git-tracked, never deleted). Off the board, but readable via
 * listArchivedTasks. Returns null if the active card is absent.
 *
 * Guard a (kobo-45): archiving an epic with still-open children is BLOCKED —
 * throws EpicArchiveBlockedError listing them, so the family isn't hidden while
 * work is in flight. `force` bypasses the guard (the aging sweep, which already
 * pre-checks). A leaf card or an epic whose children are all done archives freely.
 */
export function archiveTask(company: string, id: string, by: string, opts: { force?: boolean } = {}): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (!opts.force) {
    const open = openEpicChildren(id, listTasks(company));
    if (open.length) throw new EpicArchiveBlockedError(id, open.map((c) => c.id));
  }
  mkdirSync(archiveDir(company), { recursive: true });
  renameSync(taskFilePath(company, id), archivedTaskFilePath(company, id));
  emit(task, by, "task-archived", `archived ${task.id}: ${task.title}`);
  releaseAllClaims(task); // an archived card must leave no open claim behind (kobo-107)
  promoteReadyChildren(company, id, by); // kobo-133: archived satisfies deps too (same as done)
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
  const active = listTasks(company);
  const archived: TaskRecord[] = [];
  for (const t of active) {
    if (isOnBoard(t, days, now)) continue; // skips non-done + recent done
    if (openEpicChildren(t.id, active).length) continue; // keep a parent on-board while children are alive (kobo-45)
    const a = archiveTask(company, t.id, by, { force: true }); // guard already satisfied above
    if (a) archived.push(a);
  }
  return archived;
}

/** Find the task in a company carrying this PR number (for PR-watch auto-done). */
/**
 * All non-done cards carrying this PR (one PR may bind several cards). When
 * `repo` is given, a card that carries a DIFFERENT repo is excluded — PR numbers
 * are only unique within a repo, so a merged owner/a#5 must not flip a card
 * bound to owner/b#5 (kobo-99: cross-repo PR# collision → false done, board lie).
 * A repo-less card still matches by number alone: it has no repo to conflict and
 * the pr-watch heal (kobo-80) backfills it on the flip.
 */
export function findTasksByPr(company: string, pr: number, repo?: string): TaskRecord[] {
  // Skip BOTH terminal states: a done OR rejected card must never be resurrected
  // by a later PR-merge poll. Rejected = "closed, not accepted" — flipping it to
  // done on merge would be the kobo-99 resurrection bug in a new guise (kobo-101).
  return listTasks(company).filter(
    (t) => t.pr === pr && t.state !== "done" && t.state !== "rejected" && (!repo || !t.repo || t.repo === repo),
  );
}

export function findTaskByPr(company: string, pr: number, repo?: string): TaskRecord | null {
  return findTasksByPr(company, pr, repo)[0] ?? null;
}

/** Pull a GitHub PR number out of a reply message (…/pull/<n>). null if none. */
export function parsePrNumber(text: string): number | null {
  const m = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i.exec(text);
  return m ? +m[1] : null;
}

/** Pull `owner/repo` out of a full GitHub PR url (kobo-80 — enforce repo on pr-link). */
export function parsePrRepo(text: string): string | undefined {
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i.exec(text);
  return m?.[1];
}

/**
 * Derived "needs an owner" block (eq3-011 kobo-14 — Tony's rule: no one doing it
 * → it must show as blocked, not sit silently in todo). A `todo` card with no
 * assignee is off-flow: nobody's on it. Derived at read (like dependency-block),
 * NEVER stored → auto-clears the moment someone is assigned. `backlog` is exempt
 * (intentionally not-ready), and any non-todo state has its own real owner/flow.
 */
export function needsOwner(task: TaskRecord): boolean {
  return (task.state === "todo" || task.state === "ready") && !task.assignee; // ready is "even more todo" (kobo-133)
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
    case "approve":
      return "รอ Tony เคาะ (approve → done)"; // kobo-189 — human gate after worker review
    case "need-answer":
      // kobo-218 — Tony's decision queue; owner moves the card on once answered.
      return `รอ Tony ตอบ${task.reviewReason ? ` (${task.reviewReason})` : ""}`;

    case "in-progress":
      if (task.assignee && task.by !== task.assignee) return `${task.by} รอ ${task.assignee}`;
      return task.assignee ? `${task.assignee} กำลังทำ` : "รอคนหยิบ";
    case "todo":
      // assigned todo → waiting on that person to START (was wrongly "รอคนหยิบ");
      // unassigned todo → needs an owner (surfaced off-flow in the Blocked lane).
      return task.assignee ? `รอ ${task.assignee} เริ่ม` : "⚑ ยังไม่มีเจ้าของ — รอ assign";
    case "ready":
      // deps ครบแล้ว (kobo-133) — same waits as todo, but the gate is known open.
      return task.assignee ? `deps ครบ — รอ ${task.assignee} เริ่ม` : "⚑ deps ครบ แต่ยังไม่มีเจ้าของ — รอ assign";
    case "backlog":
      return "ยังไม่พร้อม (backlog)";
    case "done":
      return "เสร็จแล้ว ✓";
    case "rejected":
      return `ไม่รับ ✗${task.rejectReason ? ` (${task.rejectReason})` : ""}`;
    default:
      return "";
  }
}

/** Silence window for the stuck-decision badge (mawjs-5) — mirrors presence ACTIVE_MS. */
export const STALE_DECISION_MS = 10 * 60 * 1000; // 10 min

/**
 * Newest worklog ts per oracle (mawjs-5 backstop). Excludes 'idle' — a pane-state
 * signal fired every turn-end, not real work — so an owner who wandered off reads
 * as silent even while the pane heartbeats. Read once, reused across every card.
 */
export function lastActivityByOracle(company: string | null | undefined): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of readWorklog(company, { excludeKinds: ["idle"] })) {
    if (e.oracle && (map[e.oracle] === undefined || e.ts > map[e.oracle])) map[e.oracle] = e.ts;
  }
  return map;
}

/**
 * Soft "stuck? ball on?" badge (mawjs-5 BACKSTOP) — DERIVED, NEVER mutates state.
 * A no-PR card sitting in-progress whose owner has emitted no real worklog event
 * for STALE_DECISION_MS is *maybe* a decision card the owner finished but forgot to
 * hand off (the assign gesture). Visual only: silence is ambiguous (thinking / away /
 * done look identical), so we never auto-flip — just flag it for a human glance.
 * Unassigned / PR-linked / non-in-progress cards are never stale here.
 */
export function isStaleDecisionCard(task: TaskRecord, lastActivityTs: number | undefined, now: number): boolean {
  if (task.state !== "in-progress" || task.pr || !task.assignee) return false;
  if (lastActivityTs === undefined) return true; // no real activity in the log at all → silent
  return now - lastActivityTs > STALE_DECISION_MS;
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

/**
 * Auto-promote todo→ready (kobo-133, Hermes-style: state machine, not view).
 * After `doneId` reaches done/archived, every active `todo` card that depends on
 * it and now has NO pending parent flips to `ready` — the board says "gate
 * opened, pick me up" without a human sweep. Only cards that HAVE parentIds are
 * eligible: a dep-less todo card keeps its lane (todo still means "not gated").
 * Called from completeTask/archiveTask, so CLI done, web done, and the pr-watch
 * merge flip all promote through the one shared path. Returns the promoted cards.
 */
export function promoteReadyChildren(company: string, doneId: string, by: string): TaskRecord[] {
  const resolve = parentStateResolver(company);
  const promoted: TaskRecord[] = [];
  for (const t of listTasks(company)) {
    if (!t.parentIds?.includes(doneId)) continue;
    // kobo-223: two kinds are eligible — a DEPENDENCY-blocked card (state=blocked,
    // kind=dependency, the new persisted form) and a legacy derived-todo card (never
    // persisted-blocked). An explicit block (kind !== dependency) is NOT eligible:
    // its dep clearing must NOT release it — a human unblock does (3a multi-source).
    const wasDepBlocked = t.state === "blocked" && t.block?.kind === "dependency";
    if (!wasDepBlocked && t.state !== "todo") continue;
    if (dependencyBlock(t, resolve).blockedBy.length) continue; // another parent still pending
    if (wasDepBlocked) {
      // restore EXACT pre-block state (2a) — in-progress→in-progress stays put here.
      t.state = t.prevState ?? "todo";
      delete t.block;
      delete t.prevState;
    }
    // kobo-133 (no-regress): a card that lands on todo with all deps cleared is
    // "ready — pick me up". Applies to a restored-todo AND a legacy derived-todo.
    if (t.state === "todo") t.state = "ready";
    t.updatedTs = Date.now();
    writeTaskRecord(t);
    emit(t, by, "task-updated", `${t.state} ${t.id} (deps ครบ): ${t.title}`);
    promoted.push(t);
  }
  return promoted;
}

/** True when any parent is still pending (the card is held off the flow). */
export function isBlockedByDependency(
  task: TaskRecord,
  getParentState: (id: string) => ParentState,
): boolean {
  return dependencyBlock(task, getParentState).blockedBy.length > 0;
}

/**
 * Reconcile a card's dependency-block state (kobo-223). A dependency block is now
 * a REAL persisted state — `state="blocked"` + `block={kind:"dependency"}` — the
 * SAME shape as an explicit block, so the board reads one truth (Board Truth: no
 * lie) instead of a card sitting in-progress with only a derived overlay (the
 * pgw-197 symptom). Mutates in place; the caller writes + emits. Round-trips:
 *  - ENTER: a card in a FLOW state (todo/ready/in-progress) with ≥1 pending parent
 *    → blocked, `prevState` remembering where to return.
 *  - EXIT: a DEPENDENCY-blocked card whose parents all cleared → restored to its
 *    EXACT `prevState` (kobo-223 2a: todo→todo, in-progress→in-progress — restoring
 *    the wrong state is a board-lie). The kobo-133 todo→ready "deps ครบ" promotion
 *    is a SEPARATE parent-done step in promoteReadyChildren, not baked here.
 * Explicit blocks (block.kind !== "dependency") are LEFT ALONE — only a human
 * `unblock` releases them (no regress). A card blocked by BOTH sources stays
 * blocked until BOTH clear: dependency clears here only when the block IS a
 * dependency block; an explicit re-block overwrites the kind, so this won't
 * touch it (kobo-223 3a). Never blocks a `backlog`/terminal card (already
 * parked). Returns "blocked" | "restored" | null (what it did).
 */
function reconcileDependencyState(
  task: TaskRecord,
  resolve: (id: string) => ParentState,
): "blocked" | "restored" | null {
  const pending = dependencyBlock(task, resolve).blockedBy.length > 0;
  if (pending) {
    // enter only from an actionable flow state; never touch an explicit or an
    // already-dependency block (leave its prevState + kind intact).
    if (task.state !== "todo" && task.state !== "ready" && task.state !== "in-progress") return null;
    task.prevState = task.state;
    task.state = "blocked";
    task.block = { kind: "dependency" };
    return "blocked";
  }
  // no pending parent — restore ONLY a card WE dependency-blocked (not explicit).
  if (task.state === "blocked" && task.block?.kind === "dependency") {
    task.state = task.prevState ?? "todo"; // EXACT restore (kobo-223 2a) — no auto-ready here
    delete task.block;
    delete task.prevState;
    return "restored";
  }
  return null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Approval-card 9-section template (kobo-222) — a deploy/money-path approve-card
// (born in the Approve lane via `add --state approve`, kobo-218) must give Tony
// everything to decide without asking. The template is the SINGLE source: it
// PREFILLS a body when the creator supplies none, and its section numbers drive
// the soft missing-section warn when they DO supply one. Prototype: pgw-191 c6/c7/c8.
// Lazy: markdown headings, no per-field schema — the body stays git-diff'able +
// hand-editable (same call as checklistProgress), and the warn guides without
// blocking (a reason is already mandatory; over-validation would just annoy).
export interface ApprovalSection {
  n: number; // 1–9, drives both the heading and the missing-section scan
  head: string; // heading text (Thai, matches the board copy)
  hint: string; // placeholder guidance rendered as an HTML comment in the prefill
}
export const APPROVAL_SECTIONS: ApprovalSection[] = [
  { n: 1, head: "Deploy อะไร", hint: "service + version (from→to) + tool" },
  { n: 2, head: "แก้อะไร/ทำไม", hint: "plain language" },
  { n: 3, head: "กระทบใคร", hint: "blast radius — merchant count · shared driver · isolate?" },
  { n: 4, head: "เงิน", hint: "ทิศทาง in/out · money-out=0?" },
  { n: 5, head: "Rollback", hint: "command + ปลายทางย้อนกลับ" },
  { n: 6, head: "เสี่ยง/verify-gap", hint: "+ Tony-accepted-risk ref" },
  { n: 7, head: "PR + link", hint: "clickable" },
  { n: 8, head: "Diff summary", hint: "per-PR +/-/ · NET delta (tag→tag) · runtime vs non-runtime" },
  { n: 9, head: "HONEST delta", hint: "scope เต็ม — commit พ่วง / dep bump ถ้ามี" },
];

/** The prefilled approval-card body: 9 numbered headings, each with a hint comment. */
export function approvalTemplate(): string {
  return APPROVAL_SECTIONS.map((s) => `## ${s.n}. ${s.head}\n<!-- ${s.hint} -->\n`).join("\n");
}

/**
 * Section numbers absent from a body → the soft-warn set (kobo-222). A section is
 * PRESENT when a line starts with its number + dot (optionally under a markdown
 * heading), e.g. `## 3.` or `3.` — the shape the template writes and a filler
 * keeps. Returns the missing sections in order (empty = all 9 present). Never
 * throws on an empty/absent body (every section missing → the whole set).
 */
export function missingApprovalSections(body?: string): ApprovalSection[] {
  const present = new Set<number>();
  for (const line of (body ?? "").split("\n")) {
    const m = line.match(/^\s*#{0,6}\s*([1-9])\./);
    if (m) present.add(Number(m[1]));
  }
  return APPROVAL_SECTIONS.filter((s) => !present.has(s.n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Containment (kobo-45) — epic→task→subtask via the `epic` parent-id field. A
// SEPARATE axis from parentIds[] deps: containment = "lives under", dep = "waits
// for". Only the `epic` id is stored; rollup + parent-chip are derived at read,
// the loop check + archive block are enforced at write. Close stays MANUAL.
// ─────────────────────────────────────────────────────────────────────────────

/** Raised when archiving an epic that still has open (not-done) children (guard a). */
/**
 * Thrown by {@link assignTask} when a bare reassign would displace an existing
 * owner without `--force-reassign`. Message steers to the two legitimate paths:
 * correction (with the flag) or handoff-as-subtask. (kobo-219, Board Truth rule 9)
 */
export class ReassignFrictionError extends Error {
  constructor(
    public readonly id: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      `reassign blocked: ${id} is already assigned to ${from}. Reassign is for correction only ` +
        `(wrong-assignee / board-lie fix) — pass --force-reassign to confirm ${from} → ${to}. ` +
        `To hand off part of the work, create a subtask (the parent keeps its assignee), not a reassign.`,
    );
    this.name = "ReassignFrictionError";
  }
}

export class EpicArchiveBlockedError extends Error {
  constructor(
    public readonly epicId: string,
    public readonly activeChildren: string[],
  ) {
    super(
      `cannot archive ${epicId}: ${activeChildren.length} open child card(s) — ${activeChildren.join(", ")}`,
    );
    this.name = "EpicArchiveBlockedError";
  }
}

/**
 * Would setting `id`'s containment parent to `newEpic` create a cycle? Walks the
 * ancestor chain UP from newEpic via `getEpic`; if it reaches `id`, then `id` is
 * already an ancestor of newEpic and the link would close a loop. A visited set
 * guards a pre-existing upstream cycle (returns false — not the loop we're about
 * to create). `getEpic` returns a card's own parent id, or undefined at the root
 * / when the id resolves to nothing.
 */
export function createsEpicLoop(
  id: string,
  newEpic: string | undefined,
  getEpic: (cardId: string) => string | undefined,
): boolean {
  let cur = newEpic;
  const visited = new Set<string>();
  while (cur) {
    if (cur === id) return true; // id reachable by walking up from newEpic → cycle
    if (visited.has(cur)) return false; // pre-existing cycle above, not through id
    visited.add(cur);
    cur = getEpic(cur);
  }
  return false;
}

/**
 * Set (or clear, with empty/undefined) a card's containment parent — the ONLY
 * write path that can create a cycle (a fresh `add` can't, its id is new). Rejects
 * a self- or ancestor-loop by throwing (spec: reject on write). A parent id that
 * doesn't resolve is allowed — it renders as a plain tag (backward-compat).
 * Returns null if the card is absent; throws on a loop.
 */
export function setTaskEpic(
  company: string,
  id: string,
  epicId: string | undefined,
  by: string,
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const next = epicId?.trim() || undefined;
  if (next) {
    if (next === id || createsEpicLoop(id, next, (cid) => readTask(company, cid)?.epic ?? undefined)) {
      throw new Error(`epic loop rejected: ${id} ↳ ${next} would create a containment cycle`);
    }
    task.epic = next;
    // Re-link (kobo-72): a card can't both wait-for (dependency) and live-under
    // (containment) the same parent — moving `next` onto the containment axis drops
    // a stale `next` dependency so the axes never contradict. Other deps are kept.
    if (task.parentIds?.length) {
      const kept = task.parentIds.filter((p) => p !== next);
      if (kept.length) task.parentIds = kept;
      else delete task.parentIds;
    }
  } else {
    delete task.epic;
  }
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", next ? `set parent ${id} ↳ ${next}` : `cleared parent of ${id}`);
  return task;
}

/**
 * Would adding dep `id 🚫→ newParent` close a dependency cycle? BFS UP the
 * parentIds graph from newParent; reaching `id` means `id` already (transitively)
 * blocks newParent, so the new link would deadlock both (each waits forever).
 * The DERIVED blocked-by stays loop-safe either way (dependencyBlock is 1-hop by
 * construction) — this guards the human-facing deadlock, not the derivation. The
 * visited set terminates on a pre-existing upstream cycle (hand-edited files).
 */
export function createsDepLoop(
  id: string,
  newParent: string,
  getParentIds: (cardId: string) => string[],
): boolean {
  const queue = [newParent];
  const visited = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === id) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    queue.push(...getParentIds(cur));
  }
  return false;
}

/**
 * Add / remove ONE dependency link (parentIds, ADR 0003 A) after create — the
 * dep-axis sibling of setTaskEpic (kobo-134; before this, deps were fixed at
 * `add --parent` or hand-edited JSON). add guards: self-dep, a link duplicating
 * the containment parent (the two axes must not contradict, kobo-72), and a dep
 * cycle (mutual wait = deadlock). Both ops are idempotent: adding an existing
 * link / removing an absent one returns the card unchanged (no write, no event).
 * Returns null when the card is absent; throws on a guard violation.
 */
export function setTaskDep(
  company: string,
  id: string,
  parentId: string,
  op: "add" | "rm",
  by: string,
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const dep = parentId.trim();
  const cur = task.parentIds ?? [];
  if (op === "add") {
    if (dep === id) throw new Error(`dep rejected: ${id} cannot wait for itself`);
    if (dep === task.epic) {
      throw new Error(`dep rejected: ${dep} is already ${id}'s containment parent (epic) — wait-for and lives-under must not contradict`);
    }
    if (cur.includes(dep)) return task; // idempotent — link already there
    if (createsDepLoop(id, dep, (cid) => readTask(company, cid)?.parentIds ?? [])) {
      throw new Error(`dep loop rejected: ${id} 🚫→ ${dep} would create a wait cycle (mutual deadlock)`);
    }
    task.parentIds = [...cur, dep];
  } else {
    if (!cur.includes(dep)) return task; // idempotent — nothing to remove
    const kept = cur.filter((p) => p !== dep);
    if (kept.length) task.parentIds = kept;
    else delete task.parentIds;
  }
  // kobo-223: keep the blocked state honest as deps change — adding a pending dep
  // to a flow-state card blocks it; removing the last pending dep from a
  // dependency-blocked card restores its exact prior state (explicit blocks
  // untouched). A dep rm doesn't auto-promote to ready (that's the parent-DONE
  // path, promoteReadyChildren) — it restores exactly.
  reconcileDependencyState(task, parentStateResolver(company));
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", op === "add" ? `dep ${id} 🚫→ ${dep} (waits for)` : `dep removed ${id} ✂ ${dep}`);
  return task;
}

/**
 * Direct containment children of a card — those whose `epic` === id. Pure over a
 * given card set so the CALLER controls scope: pass `listTasks` for on-board
 * children, or active+archived when a rollup must count swept-done children too.
 */
export function epicChildren(id: string, cards: TaskRecord[]): TaskRecord[] {
  return cards.filter((c) => c.epic === id);
}

/**
 * Children that are NOT done — the set that blocks archiving (guard a) and drives
 * the done-confirm prompt (guard b — the store allows the close, the caller
 * confirms). `done` is the only satisfied state; every other (incl. blocked) is open.
 */
export function openEpicChildren(id: string, cards: TaskRecord[]): TaskRecord[] {
  return epicChildren(id, cards).filter((c) => c.state !== "done");
}

/**
 * One child in a decompose plan (kobo-146, C7). The LLM drafting lives in the
 * SKILL (out of scope) — this is the deterministic executor: it materializes a
 * confirmed plan into real cards. `deps` entries are either an existing card id
 * OR a sibling ref `$N` (0-indexed into THIS plan) so a plan can express "child 2
 * waits for child 0" before the ids exist. body carries the AC (Given/When/Then).
 */
export interface DecomposeChild {
  title: string;
  body?: string;
  deps?: string[]; // existing card id | "$N" sibling ref (0-indexed into children[])
  assignee?: string;
  reviewer?: string;
}

export interface DecomposeResult {
  epic: string;
  created: { index: number; id: string; title: string }[];
  skipped: { index: number; id: string; title: string }[]; // title already existed under the epic (idempotent re-run)
  failed?: { index: number; title: string; error: string }; // a child create threw → stop, report what landed
  depWarnings: string[]; // a dep couldn't be linked (bad $N ref / cycle / self) — best-effort, cards still created
}

/**
 * Decompose an epic into a set of child cards + links in one call (kobo-146, C7,
 * option B — zero new infra, reuses addTask/setTaskEpic/setTaskDep). NOT atomic
 * (file-per-card can't be), so the contract is HONEST-on-partial-failure:
 *   - creates children in order, each under `epicId` (containment link);
 *   - IDEMPOTENT: a child whose title already exists under the epic is SKIPPED
 *     (re-running a plan doesn't duplicate) — its existing id still resolves `$N`;
 *   - on a create throw it STOPS and returns `failed` + everything already created
 *     (never silent — the caller reports what landed so the human can resume);
 *   - after all children exist, resolves each `deps` entry (`$N` → the Nth child's
 *     id, else a literal card id) and links it with setTaskDep; a bad ref / cycle
 *     becomes a depWarning (best-effort — the cards are the point, links are additive).
 * Promotes the parent to kind=epic (decomposing IS making it a container). Throws
 * only if the epic card is absent (can't decompose what isn't there).
 */
export function decomposeEpic(company: string, epicId: string, children: DecomposeChild[], by: string): DecomposeResult {
  const epic = readTask(company, epicId);
  if (!epic) throw new Error(`epic not found: ${epicId}`);
  // Promote the parent to an epic container — decomposing it makes it one (kobo-45).
  if (epic.kind !== "epic") {
    epic.kind = "epic";
    epic.updatedTs = Date.now();
    writeTaskRecord(epic);
  }

  const result: DecomposeResult = { epic: epicId, created: [], skipped: [], depWarnings: [] };
  // Existing titles under the epic → idempotent skip (re-run safety).
  const existing = new Map(epicChildren(epicId, listTasks(company)).map((c) => [c.title, c.id] as const));
  // index → created/existing id, so a `$N` sibling ref resolves even to a skipped child.
  const idByIndex: (string | null)[] = children.map(() => null);

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const title = child.title?.trim();
    if (!title) { result.failed = { index: i, title: child.title ?? "", error: "child title is required" }; return result; }
    const already = existing.get(title);
    if (already) { result.skipped.push({ index: i, id: already, title }); idByIndex[i] = already; continue; }
    try {
      const card = addTask({ company, by, title, epic: epicId, body: child.body, assignee: child.assignee ?? null, reviewer: child.reviewer });
      result.created.push({ index: i, id: card.id, title });
      idByIndex[i] = card.id;
    } catch (e) {
      result.failed = { index: i, title, error: e instanceof Error ? e.message : String(e) };
      return result; // stop — report what already landed (never silent)
    }
  }

  // Second pass: link deps now that every child has an id.
  for (let i = 0; i < children.length; i++) {
    const childId = idByIndex[i];
    if (!childId) continue;
    for (const ref of children[i].deps ?? []) {
      const m = /^\$(\d+)$/.exec(ref.trim());
      const depId = m ? idByIndex[Number(m[1])] : ref.trim();
      if (m && (depId == null)) { result.depWarnings.push(`${childId}: sibling ref ${ref} out of range / not created`); continue; }
      try {
        setTaskDep(company, childId, depId!, "add", by);
      } catch (e) {
        result.depWarnings.push(`${childId} 🚫→ ${depId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  emit(epic, by, "task-updated", `decomposed ${epicId} → ${result.created.length} card(s)${result.skipped.length ? ` (+${result.skipped.length} existing)` : ""}`);
  return result;
}

export interface EpicRollup {
  done: number;
  total: number;
  allDone: boolean; // total>0 && every child done → badge "ลูกครบ รอปิด" (close is still MANUAL)
}

/**
 * Derived N/M rollup for an epic. Null when it has no children (a plain card — no
 * badge). NEVER stored, and never flips the epic's state: closing an epic is
 * manual (pr-watch lesson — automation that flips state ends up lying). `allDone`
 * is the "ลูกครบ รอปิด" signal, not an auto-close trigger.
 */
export function epicRollup(id: string, cards: TaskRecord[]): EpicRollup | null {
  const kids = epicChildren(id, cards);
  if (!kids.length) return null;
  const done = kids.filter((c) => c.state === "done").length;
  return { done, total: kids.length, allDone: done === kids.length };
}

export interface EpicParentRef {
  id: string;
  state: ParentState; // resolved parent state, "archived", or null when unresolvable
  archived: boolean; // parent archived → chip shows "(archived)", never blocks (guard c)
  resolved: boolean; // false → id shown as a plain backward-compat tag
}

/**
 * Resolve a card's containment parent for display (guard c + backward-compat).
 * Reuses parentStateResolver's states: an archived parent yields a chip that
 * reads "(archived)" but never blocks; an unresolvable id yields resolved:false
 * so the caller shows it as a plain tag rather than erroring.
 */
export function resolveEpicParent(
  epicId: string,
  getState: (id: string) => ParentState,
): EpicParentRef {
  const st = getState(epicId);
  return { id: epicId, state: st, archived: st === "archived", resolved: st !== null };
}

/**
 * All descendant cards under an epic — direct children AND their children, etc.
 * (epic→task→subtask nests arbitrarily). A visited set makes it safe even if a
 * cycle somehow slipped in (setTaskEpic guards writes, but a hand-edited file
 * could still loop). Pure over a given card set — the caller picks the scope.
 */
export function descendantCards(epicId: string, cards: TaskRecord[]): TaskRecord[] {
  const byParent = new Map<string, TaskRecord[]>();
  for (const c of cards) {
    if (!c.epic) continue;
    (byParent.get(c.epic) ?? byParent.set(c.epic, []).get(c.epic)!).push(c);
  }
  const out: TaskRecord[] = [];
  const seen = new Set<string>([epicId]);
  const stack = [...(byParent.get(epicId) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    stack.push(...(byParent.get(c.id) ?? []));
  }
  return out;
}

/** A note carried up to an ancestor's modal, tagged with the card it came from. */
export interface FamilyNote extends TaskNote {
  from: string; // source card id (a descendant of the epic)
}

/**
 * Descendant notes for an epic's parent modal (kobo-46 §Comment) — every note on
 * every card under this epic, tagged with `from` and merged oldest-first. The
 * epic's OWN notes are NOT included (they're already on the card as `notes`); the
 * renderer (c3) concatenates the two for the full family timeline. Derived at
 * read, never stored.
 */
export function familyNotes(epicId: string, cards: TaskRecord[]): FamilyNote[] {
  const out: FamilyNote[] = [];
  for (const c of descendantCards(epicId, cards)) {
    for (const n of c.notes ?? []) out.push({ ...n, from: c.id });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
