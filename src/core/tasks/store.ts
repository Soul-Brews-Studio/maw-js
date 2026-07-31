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
import { appendWorklog, openClaims, readWorklog, worklogCacheProbe } from "../worklog/store";
import type { WorklogEntry, WorklogKind } from "../worklog/types";
import { notifyParentOfSubcardDone } from "./notify";
import { classifySignTiers, type DiffFile } from "./sign-tier-classifier";
import { findSimilarOpenCards, type ScopeOverlapWarning } from "./duplicate-scope-warn";

export type TaskState =
  | "backlog"
  | "todo"
  | "ready" // deps cleared, actionable (kobo-133) — auto-promoted from todo when all parentIds are done/archived
  | "in-progress"
  | "review"
  | "need-answer" // kobo-218 — Tony's DECISION queue ("จะเอายังไง"), off-flow; distinct from approve (yes/no gate) and blocked (waiting on another card)
  | "approve" // kobo-189 — human gate between review (worker-checked) and done (merged)
  | "wait-for-deploy" // kobo-273 — merged≠live park lane: a deploy-required card waits here after PR merge until the manual deploy lands, then → done
  | "external-wait" // Cell v2: non-WIP wait for a named external trigger
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
  "wait-for-deploy",
  "external-wait",
  "done",
  "rejected",
  "blocked",
];

// Linear flow columns. Both `need-answer` (kobo-218) and `blocked` are OFF-flow
// Tony/dependency detours — surfaced as their own lanes, never a progression step.
export const TASK_FLOW: TaskState[] = ["backlog", "todo", "ready", "in-progress", "review", "approve", "wait-for-deploy", "external-wait", "done"];

// Terminal dispositions — a finished card. Derived off-flow signals (a still-pending
// dependency, needs-owner) must NOT re-surface it: a done/rejected card doesn't care
// that a parent is still open (kobo-246 — DISPLAY gate only; dependencyBlock itself is
// unchanged). "archived" isn't a live board state but is terminal for parent-resolution.
export const TERMINAL_STATES: readonly (TaskState | "archived")[] = ["done", "rejected", "archived"];
export function isTerminalState(state: TaskState | "archived"): boolean {
  return TERMINAL_STATES.includes(state);
}

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
  // kobo-263: structured clarity for a comment addressed to Tony/human. tldr + ask are
  // REQUIRED on a @tony/@human comment (the tool rejects without them); detail is optional.
  // Absent on an agent↔agent comment (fields are free there) and on legacy comments.
  tldr?: string; // 1-line outcome/decision
  ask?: string; // what Tony must do (pick X? approve Y?)
  detail?: string; // optional evidence/context — rendered collapsed
  // kobo-237: the resolve concept is removed (verb/read/write gone everywhere). These
  // three fields are KEPT in the type as LEGACY-ONLY (Nothing is Deleted) so a comment
  // that carries them from before still deserializes — nothing reads or writes them now.
  resolved?: boolean; // LEGACY (kobo-237) — no longer read/written
  resolvedBy?: string; // LEGACY (kobo-237)
  resolvedTs?: number; // LEGACY (kobo-237)
  fromNote?: number; // origin note ts when copied from a question-note (kobo-142 migration) — idempotency marker + provenance
}

/** Cell v2 evidence is durable card state, not pane memory or prose-only comments. */
export interface TaskEvidenceBlock {
  scope: "producer" | "independent" | "epic";
  changed: string;
  verified: string;
  ref?: string;
  sha?: string;
  locus: string;
  limitations: string;
  by: string;
  ts: number;
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
  // kobo-594: the board's ONLY source for whether the linked PR is actually mergeable
  // on GitHub — before this, "all signs in" + a PR link read as "ready to merge" with
  // NOTHING checking the PR's real state, so a card stayed silent through a real
  // CONFLICTING PR (proven live: alpha absorbing sibling PRs flipped #371/#375
  // CONFLICTING in the same minute, board still said "รอ merge"). Written by
  // pr-watch's poll (setTaskPrMergeState) from `gh pr list --json mergeable,
  // mergeStateStatus` — the SAME call pr-watch already makes for open/merged/closed
  // detection, so this costs zero extra `gh` calls. Absent = never successfully
  // checked; a failed/rate-limited `gh` call leaves these UNCHANGED (never writes a
  // fake value) — absence must never be read as "mergeable" (the unhappy-path AC).
  prMergeable?: string; // raw GitHub value: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" (GitHub's own lazy-compute-pending state, not this repo's "we never checked")
  prMergeStateStatus?: string; // raw GitHub value: "CLEAN" | "DIRTY" | "BLOCKED" | "BEHIND" | "UNSTABLE" | "UNKNOWN" | "DRAFT" — richer detail than prMergeable alone
  prMergeCheckedTs?: number; // epoch ms of the last SUCCESSFUL check — staleness must always be readable from this, never assumed fresh
  deployRequired?: boolean; // kobo-274 — when its PR merges, park in wait-for-deploy (merged≠live) instead of done. Unset → defaults to "has a PR" (Tony option a); set explicitly to override either way.
  block?: TaskBlock; // set when state = blocked (explicit block — ADR 0003 B)
  prevState?: TaskState; // flow state to return to on unblock
  reviewer?: string; // who should review/take over (set when state = review, optional)
  reviewerCellId?: string; // Cell v2: durable cross-cell reviewer routing
  reviewReason?: string; // why it needs review (optional)
  reviewRejectCount?: number; // Cell v2: review rejection loop count
  readyForExternalReviewAt?: number; // readiness/sign gate for cross-cell notification
  externalWaitTrigger?: string; // required wake signal while state=external-wait
  evidence?: TaskEvidenceBlock[]; // structured producer/independent/epic evidence
  reviewerPane?: string; // kobo-587: the tmux %pane-id that `--to-pane` resolved to and that the DISPATCHING caller verified is (a) a live pane, (b) in the caller's own tmux session, and (c) not the caller's own pane (same pane-grain binding as crewSignedByPane, kobo-346) — NOT proof anyone at that pane has looked at anything yet, only that a distinct, same-session pane was named. This is what lets resolveReviewer treat a same-oracle-different-pane reviewer as independent instead of falling to human. Live-resolved in the DISPATCHING caller's shell (not the reviewer's) → agent-settable → DEFENSE-IN-DEPTH, not airtight (same ceiling as kobo-346, and kobo-460's pane-id-reuse-across-sessions applies here too).
  rejectReason?: string; // why the card was rejected (kobo-101) — MANDATORY on reject, kept to learn (Nothing is Deleted)
  requestId?: string; // dispatch correlation id — set for auto-created tasks (idempotency key)
  parentIds?: string[]; // card→card deps (ADR 0003 A) — blocked-by-dependency is DERIVED, never stored
  body?: string; // free text: why/detail + markdown checklist (ADR 0003 C) — git-diff'able
  notes?: TaskNote[]; // append-only notes (kobo-39) — mid-flight truth, oldest first, NEVER mutated/deleted
  comments?: TaskComment[]; // threaded ask/answer comments (kobo-140) — resolve flips a flag, never deleted
  room?: string; // provenance (kobo-244) — the brainstorm-room artifact id this card was distilled from (bidirectional; the room records this card id back)
  crewGate?: boolean; // kobo-327: this card goes through a crew cell → merge needs a crew pre-sign IN ADDITION to head. Unset → single-tier (head only), never hard-required (a non-crew card must still be mergeable). Set at crew dispatch (kobo-328) or self-marked when a crew signs.
  crewSignedBy?: string; // kobo-327: oracle that crew-signed (pre-PR gate). who+ts mirrors the reviewer field convention.
  crewSignedTs?: number; // epoch ms
  crewSignedByPane?: string; // kobo-346: the tmux %pane-id that crew-signed (pane-grain identity — a v2 crew has many panes of ONE oracle; this binds the SIGNING pane). Live-resolved in the signer's shell → agent-settable → DEFENSE-IN-DEPTH, not airtight.
  crewSignedSha?: string; // kobo-400: the PR head SHA at crew-sign time (best-effort, `gh pr view --json headRefOid`) — binds WHAT was reviewed, not just when. Absent = a pre-kobo-400 sign (legacy, grandfathered at merge).
  // kobo-578: the diff's OWN hash (`git patch-id --stable` on the PR diff) — unlike
  // crewSignedSha, this is stable across a rebase/merge that moves ancestry without
  // touching a single line (the common case: a sibling PR merges underneath this
  // one). Used to tell "same reviewed content, new commit id" apart from "actually
  // different code" when a tier gets re-signed.
  crewSignedPatchId?: string;
  headSignedBy?: string; // kobo-327: oracle that head-signed (final gate before merge)
  headSignedTs?: number; // epoch ms
  headSignedByPane?: string; // kobo-346: the tmux %pane-id that head-signed (same pane-grain binding as crewSignedByPane)
  headSignedSha?: string; // kobo-400: the PR head SHA at head-sign time (same capture as crewSignedSha)
  headSignedPatchId?: string; // kobo-578: same diff-hash capture as crewSignedPatchId, head tier
  // kobo-501: what JUSTIFIED the sign — a diff-read and a mutation-verified run look
  // identical on the board without this (kobo-482: one mutation artifact got counted
  // toward BOTH tiers because nothing recorded which tier actually produced it).
  // "undeclared" is the write-time default when the caller passes nothing — deliberately
  // NOT "diff-read": collapsing "nobody said" into "diff-read" would recreate the exact
  // unknown-collapsed-into-known defect this whole card exists to fix (front review, c1).
  crewSignedEvidenceScope?: SignEvidenceScope;
  crewSignedEvidenceLocus?: string; // free text: worktree/path/command the evidence came from — REQUIRED (evidenceScopeViolation) whenever scope is "test-run" or above
  headSignedEvidenceScope?: SignEvidenceScope;
  headSignedEvidenceLocus?: string;
  // kobo-578: every sign a tier EVER had, pushed here right before signTask
  // overwrites the "current" scalar fields above. Nothing is Deleted — a
  // re-sign moves the current-pointer forward, it never destroys what was
  // there. There is deliberately no `unsign` verb; this is why one isn't
  // needed — the prior sign is always still readable (`sign-history <id>`).
  signHistory?: SignHistoryEntry[];
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
 * kobo-252 (state-machine core, slice A) — the Board Truth mutual-exclusion INVARIANT,
 * enforced at the SINGLE store write-path so EVERY mutation is airtight (not each of the
 * ~two-dozen mutators). A card is EITHER blocked OR in a flow lane, never both:
 *   state === "blocked"  ⟺  a `block` {kind} describing WHY it's off-flow.
 *
 * Two directions, two dispositions:
 *  - NORMALIZE the benign lie: a card in a FLOW lane (state !== "blocked") that still
 *    carries a `block`/`prevState` — e.g. `moveTask` moved it out of blocked but left
 *    the block context behind. The block is stale; strip it (+ the prevState, whose only
 *    job is "where to return on unblock"). The persisted record is then one truth.
 *  - REJECT the ambiguous lie: state === "blocked" with NO `block`. A blocked card must
 *    declare its kind (dependency/needs_input/…); a kindless block is "blocked AND not
 *    really" — we refuse to persist it (throw) so a buggy caller surfaces loudly. The
 *    blessed way into the blocked lane is `blockTask` (explicit) or the dependency
 *    reconcile — both set a block; a bare `move --state blocked` is not a path (the CLI
 *    already routes blocked via `block`).
 * Mutates `task` in place (the caller holds the same reference it emits from).
 */
function enforceBlockInvariant(task: TaskRecord): void {
  if (task.state !== "blocked") {
    delete task.block; // flow lane carries no block context
    delete task.prevState;
    return;
  }
  if (!task.block) {
    throw new Error(`task ${task.id}: state="blocked" requires a block {kind} — use blockTask or a dependency (kobo-252 invariant)`);
  }
}

/**
 * Overwrite an EXISTING card atomically — temp file in the same dir, then rename
 * over the target. Used by updates (claim/complete) where the id already exists.
 * The block↔state invariant (kobo-252) is enforced here — the single write-path.
 */
function writeTaskRecord(task: TaskRecord): void {
  enforceBlockInvariant(task);
  const path = taskFilePath(task.company, task.id);
  mkdirSync(tasksDir(task.company), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * kobo-253 (state-machine, slice B) — persist a TRANSITION with a dep re-check. Every
 * transition (start/claim/move/review/pr-open) tries to land a card in a flow lane; if a
 * dep is STILL pending, reconcile forces it to blocked (+prevState) FIRST, so a card can
 * never slip past a pending dep into an actionable lane. On a transition the mutator has
 * already set the target flow state, so reconcile's restore branch (which fires only from
 * state="blocked") is a no-op here — this is ENTER-only (auto-promote-back is slice C).
 * The write-path invariant (kobo-252 slice A) then guarantees the persisted record is one
 * truth. Use INSTEAD of writeTaskRecord in the transition mutators.
 */
function writeTaskWithDepGuard(task: TaskRecord): void {
  reconcileDependencyState(task, parentStateResolver(task.company));
  writeTaskRecord(task);
}

/**
 * kobo-394 — echo-truth, single point of truth. Every verb that calls
 * writeTaskWithDepGuard MUST emit through here instead of its own bare `emit()`:
 * reconcile can clobber the intended write to blocked (dependency still pending),
 * and the worklog/feed entry has to say THAT, not the verb's optimistic success
 * message — the echo-lie bug (kobo-394 round 1 fixed 2 sites ad hoc; round 2,
 * reviewer caught 2 MORE unconditional emits — this centralizes it so a future
 * writeTaskWithDepGuard call can't reintroduce the same lie one site at a time).
 * Call AFTER writeTaskWithDepGuard, when `task` already reflects the real result.
 */
function emitDepGuardedResult(task: TaskRecord, by: string, successKind: WorklogKind, successMsg: string): void {
  if (task.state === "blocked" && task.block?.kind === "dependency") {
    emit(task, by, "task-blocked", `blocked ${task.id} — ${task.block.reason ?? "dependency pending"}: ${task.title}`);
  } else {
    emit(task, by, successKind, successMsg);
  }
}

/**
 * Create a NEW card, claiming its id atomically via an exclusive open (O_EXCL,
 * the "wx" flag). If a concurrent writer already took this id the open throws
 * EEXIST — we report the collision so the caller can pick the next id and retry.
 * This makes id-allocation race-safe: nextTaskId alone (max+1) is not, because
 * two adds can compute the same id before either writes.
 */
export function tryCreateTaskRecord(task: TaskRecord): boolean {
  enforceBlockInvariant(task); // kobo-252: born-blocked ⟺ block, same invariant as updates
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
  deployRequired?: boolean; // kobo-274 — override the has-PR default for the merge→wait-for-deploy park
  assignee?: string | null;
  state?: TaskState; // explicit start state — dispatch passes "in-progress"; manual add omits (→ todo)
  requestId?: string; // dispatch correlation id (auto-create idempotency)
  parentIds?: string[]; // card→card deps (ADR 0003 A) — child is blocked until each parent is done/archived
  body?: string; // free text / markdown checklist (ADR 0003 C)
  reviewer?: string; // kobo-144: persistent per-card reviewer (resolve chain head)
  reviewerCellId?: string;
  reviewReason?: string; // kobo-218: born-in-approve deploy-approval card carries WHY (the Approve lane invariant — every card says why it's in Tony's queue)
  room?: string; // kobo-244: brainstorm-room artifact id this card is distilled from (provenance)
  crewGate?: boolean; // kobo-327: mark a crew-cell card at creation/dispatch → merge needs a crew pre-sign too (closes the head-merges-before-crew race)
  skipDuplicateScopeCheck?: boolean; // kobo-608: system-templated/tightly-scoped call sites opt out explicitly, per-site, with a reason comment — never left to accident of wiring order
  openCardsForScopeCheck?: TaskRecord[]; // kobo-608 review round 2: a batch caller (decomposeEpic) that already read the whole board once can pass that snapshot in, instead of paying listTasks(company) again per child (measured: ≈91ms/518 cards — 10 children re-reading it 10x is +1s for no new information, since same-batch siblings are excluded by BATCH_WINDOW_MS regardless of whether they're in the snapshot)
}

// kobo-608 review round 1: injectable seam (same shape as __setPrDiffFetcherForTest /
// __setHeadShaFetcherForTest elsewhere in this codebase, kobo-546's own lesson —
// no MAW_TEST_MODE branch around a fallible call, an injectable override instead)
// so a test can force the post-persist durable-note write to throw and prove
// addTask() still returns the already-created card rather than looking like it
// failed (review round 1: the card exists but a thrown error here would make the
// caller believe creation itself failed and re-create a duplicate).
let taskNoterForScopeWarning: typeof noteTask = noteTask;
export function __setTaskNoterForTest(fn: typeof noteTask): void {
  taskNoterForScopeWarning = fn;
}
export function __resetTaskNoterForTest(): void {
  taskNoterForScopeWarning = noteTask;
}

/**
 * Create a card. Default state = todo — a manual `add` records work that has NOT
 * started yet, even when pre-assigned (delegating ahead ≠ starting). Callers that
 * mean "started" (the `maw hey [request:]` dispatch path) pass state explicitly.
 * The assignee picks the work up themselves later via `start`/`claim`.
 */
export function addTask(input: AddTaskInput): TaskRecord & { scopeWarnings?: ScopeOverlapWarning[] } {
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
  if (input.deployRequired !== undefined) task.deployRequired = input.deployRequired; // kobo-274 — persist explicit override (incl. false), else the flip defaults to has-PR
  if (input.requestId) task.requestId = input.requestId;
  if (input.parentIds?.length) task.parentIds = [...new Set(input.parentIds)]; // dedupe, drop if empty
  if (input.body?.length) task.body = input.body;
  if (input.reviewer) task.reviewer = input.reviewer; // kobo-144: persistent per-card reviewer
  if (input.reviewerCellId) task.reviewerCellId = input.reviewerCellId;
  if (input.reviewReason) task.reviewReason = input.reviewReason; // kobo-218: born-in-approve card's WHY
  if (input.room) task.room = input.room; // kobo-244: room-artifact provenance (bidirectional link)
  if (input.crewGate) task.crewGate = true; // kobo-327: crew-cell card → merge needs crew + head sign

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

  // kobo-608 review round 1 (reviewer proved this by running it, not reading
  // code): a warn-only feature must NEVER be a hard dependency of the write
  // path every caller in the fleet shares. computed BEFORE persisting — reads
  // only cards that already exist on disk, so the candidate can never
  // self-match its own not-yet-written file. Chokepoint by design (front's
  // instruction): every real create path funnels through this one function,
  // so the check runs once here, not per-caller. FAIL-OPEN: any throw here
  // (a malformed card file, an edge case in scoring — anything) must never
  // block card creation; caught below, logged, degrades to "no warning" for
  // this one call only.
  let scopeWarnings: ScopeOverlapWarning[] = [];
  let scopeCheckError: string | undefined;
  if (!input.skipDuplicateScopeCheck) {
    try {
      scopeWarnings = findSimilarOpenCards(
        input.company,
        { title: input.title, body: input.body, parentIds: input.parentIds, epic: input.epic },
        { listTasks: input.openCardsForScopeCheck ? () => input.openCardsForScopeCheck! : listTasks, now: ts },
      );
    } catch (e) {
      scopeCheckError = e instanceof Error ? e.message : String(e);
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

  if (scopeCheckError) {
    emit(task, "system", "error", `kobo-608 scope-check failed, degraded to no-warning for this card: ${scopeCheckError}`);
  }

  if (scopeWarnings.length) {
    // Durable trace, not just an in-memory value for this one caller — the
    // in-memory `scopeWarnings` on the return dies with this call; nobody
    // reading the card later could tell it was ever warned. The note carries
    // THREE fields, not "warned already": (1) which card(s) it might overlap,
    // (2) the score, (3) that it was created anyway (creation never blocks —
    // kobo-608 AC). This is deliberate, not verbose-for-its-own-sake: today's
    // labeled set is only 3 pairs (recall can only read 0/33/67/100%, too
    // coarse to tell a good mechanism from a lucky one). Every warning that
    // keeps all 3 fields becomes a future labeled example — in a few weeks
    // there will be dozens of real (pair, score, human-decision) rows, which
    // is the only way to re-tune this without tuning toward today's 3
    // positive examples (explicitly rejected once already, see K=6 in
    // duplicate-scope-warn.ts). Trimming this note to "possibly duplicate"
    // throws that data away. Don't shorten it.
    //
    // Capped at 5 pairs (+ a "N more" tail) — review round 1 measured a real
    // 14-pair case (a title matching an existing generic-titled card) where
    // an uncapped note would list all 14; a long-lived epic with many still-
    // open children could do the same via shared-epic. Sorted strongest-first
    // by findSimilarOpenCards already, so truncation drops the weakest, not
    // the most useful signal.
    const CAP = 5;
    const shown = scopeWarnings.slice(0, CAP);
    const detail = shown
      .map((w) => `${w.id} (${w.reason}${w.score !== undefined ? `, score ${w.score.toFixed(3)}` : ""})`)
      .join(", ");
    const tail = scopeWarnings.length > CAP ? ` (+${scopeWarnings.length - CAP} more)` : "";
    // kobo-608 review round 1: noteTask runs AFTER the card is already durably
    // written — its failure must never surface as if addTask() itself failed
    // (the card exists; a thrown error here would make the caller believe
    // creation failed and re-create a duplicate, which is worse than no note
    // at all). Best-effort only.
    try {
      taskNoterForScopeWarning(input.company, task.id, "system", `⚠ possible scope overlap with ${detail}${tail} — created anyway (kobo-608)`);
    } catch (e) {
      emit(task, "system", "error", `kobo-608 durable note failed (card exists, warning not persisted): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return scopeWarnings.length ? { ...task, scopeWarnings } : task;
}

/**
 * Claim = set assignee + move to in-progress (ADR §1). Doubles as the review
 * hand-off exit: a new person claiming a review task takes it back to
 * in-progress. Clears any review flag. Returns null if absent.
 */
export function claimTask(company: string, id: string, oracle: string, opts?: { crewGate?: boolean }): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const reviewerTakesOverWork = task.state === "review" && task.reviewer === oracle;
  task.assignee = oracle;
  task.state = "in-progress";
  // Cell v2 preserves reviewer routing across close/reopen and normal worker
  // pickup. If the REVIEWER explicitly claims a card out of review, that is a
  // real hand-off/takeover; clear the reviewer fields so the board does not show
  // the new doer as their own pending reviewer.
  if (reviewerTakesOverWork) {
    delete task.reviewer;
    delete task.reviewerPane;
    delete task.reviewerCellId;
    delete task.reviewReason;
  }
  if (opts?.crewGate && !task.crewGate) task.crewGate = true; // kobo-333: crew-dispatch stamp
  task.updatedTs = Date.now();
  writeTaskWithDepGuard(task); // kobo-253: pending dep → snaps back to blocked
  emitDepGuardedResult(task, oracle, "claim", `claimed ${task.id}: ${task.title}`);
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
export function startTask(company: string, id: string, oracle: string, opts?: { crewGate?: boolean }): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const holder = task.assignee ?? oracle;
  task.assignee = holder;
  task.state = "in-progress";
  if (opts?.crewGate && !task.crewGate) task.crewGate = true; // kobo-333: crew-dispatch stamp
  task.updatedTs = Date.now();
  writeTaskWithDepGuard(task); // kobo-253: pending dep → snaps back to blocked
  emitDepGuardedResult(task, holder, "claim", `started ${task.id}: ${task.title}`);
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
  writeTaskWithDepGuard(task); // kobo-253: pending dep → lands blocked, not the target lane
  emit(task, by, "task-updated", `moved ${task.id} → ${task.state}: ${task.title}`); // task.state (blocked if dep-guarded)
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
  changes: { title?: string; body?: string; reviewer?: string; deployRequired?: boolean },
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const prev: string[] = [];
  if (typeof changes.deployRequired === "boolean" && changes.deployRequired !== task.deployRequired) {
    prev.push(`deployRequired was: ${task.deployRequired === undefined ? "(unset → default has-PR)" : task.deployRequired}`);
    task.deployRequired = changes.deployRequired; // kobo-274 — override the merge-park default
  }
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
  // kobo-328: executor≠reviewer is enforced HERE, the SSOT — a reviewer is NEVER
  // the doer, even when the field explicitly names them (a dirty --to/web-edit that
  // set reviewer=assignee must not route the review back to the person who did the
  // work). Explicit field wins only when it's independent; else creator; else human.
  // kobo-587: a recorded reviewerPane is proof independence was already VERIFIED at
  // accept-time (a distinct tmux pane accepted the review) even when the oracle name
  // equals the assignee — a crew cell shares one oracle name across many panes ("N
  // panes, 1 soul"), so name-equality alone must not downgrade to creator/human here.
  const doer = task.assignee;
  if (task.reviewer && (task.reviewer !== doer || task.reviewerPane)) return task.reviewer;
  if (task.by && task.by !== doer) return task.by; // creator reviews — unless they're the doer
  return "human"; // no independent reviewer (doer created + does it) → the human
}

/**
 * Is `who` barred from reviewing this card because they're its executor? kobo-328:
 * the dispatch-time guard mirror of resolveReviewer's SSOT rule — used to REFUSE an
 * explicit `review --to <doer>` (or web-edit) loudly instead of silently downgrading.
 */
export function isSelfReview(task: TaskRecord, who: string): boolean {
  return !!who && who === task.assignee;
}

/**
 * kobo-587: parse a `--to` value that MAY be pane-qualified as `oracle@%paneId` (the
 * tmux %pane-id format resolveSignerPane()-style callers produce) — { pane: null }
 * for a bare oracle name (the only form that existed before this card, still the only
 * form any non-crew caller ever sends).
 */
export function parseReviewTarget(to: string): { oracle: string; pane: string | null } {
  const at = to.indexOf("@");
  if (at === -1) return { oracle: to, pane: null };
  const oracle = to.slice(0, at);
  const pane = to.slice(at + 1);
  return { oracle, pane: /^%\d+$/.test(pane) ? pane : null };
}

/**
 * kobo-587: the pane-aware sibling of isSelfReview, mirroring kobo-346's sign-pane
 * guard shape. A `--to` naming the SAME oracle as the assignee is normally self-review
 * (isSelfReview's rule, unchanged) — UNLESS `to` is pane-qualified (`oracle@%id`) AND
 * that pane differs from the CALLER's own live pane: that proves the DISPATCHING
 * caller named an address that resolves to a live, same-session, distinct pane — NOT
 * that anyone at that pane has looked at the card, only that this isn't the executor
 * naming its own pane. (The CLI layer, resolvePaneIdInCallerSession, is what restricts
 * "distinct pane" to the caller's own tmux session — kobo-587 review-round-2: without
 * that, any resolvable address anywhere, including a different company's pane, counted.)
 * Any of: different oracle, bare (non-pane-qualified) `to`, or no caller pane → falls
 * straight back to isSelfReview's original behavior (AC4: zero change for every
 * pre-existing, non-pane-qualified caller).
 * CEILING: pane ids are agent-settable and not guaranteed stable across a tmux server
 * restart (kobo-460) — same defense-in-depth ceiling as kobo-346, never airtight.
 */
export function isSelfReviewPaneAware(task: TaskRecord, to: string, callerPane: string | null | undefined): boolean {
  const target = parseReviewTarget(to);
  if (target.oracle !== task.assignee) return false; // different oracle — never self-review, pane info irrelevant (AC4)
  if (target.pane && callerPane) return target.pane === callerPane; // both sides pane-qualified → compare panes, not oracle names
  return isSelfReview(task, target.oracle); // no pane info on one/both sides → original oracle-name-only behavior (AC4)
}

export interface ReviewInput {
  to?: string; // requested reviewer / next person (optional → anyone) — may be `oracle@%paneId` (kobo-587)
  cellId?: string;
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
  if (opts.to) {
    const target = parseReviewTarget(opts.to);
    task.reviewer = target.oracle; // kobo-587: store the bare oracle name — reviewerPane is the separate, explicit independence proof
    if (target.pane) task.reviewerPane = target.pane; else delete task.reviewerPane;
  }
  if (opts.cellId) task.reviewerCellId = opts.cellId;
  if (opts.reason) task.reviewReason = opts.reason; else delete task.reviewReason;
  task.updatedTs = Date.now();
  writeTaskWithDepGuard(task); // kobo-253 EDGE: review + pending dep → blocked (blocked wins)
  emitDepGuardedResult(task, by, "task-review", `review ${task.id}${opts.to ? ` → ${opts.to}` : ""}: ${task.title}`);
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
  writeTaskWithDepGuard(task); // kobo-253 EDGE: hold into review + pending dep → blocked
  emitDepGuardedResult(task, by, "task-review", `hold ${task.id} → ${resolveReviewer(task)}: ${task.title}`);
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
  writeTaskWithDepGuard(task); // kobo-253 EDGE: PR up but dep still pending → blocked, not review
  emitDepGuardedResult(task, by, "task-review", `review ${task.id} (PR #${pr}): ${task.title}`);
  return task;
}

/** Structured evidence and readiness gate. A producer block is required before external review. */
export function addTaskEvidence(
  company: string,
  id: string,
  by: string,
  block: Omit<TaskEvidenceBlock, "by" | "ts">,
): TaskRecord | null {
  if (!block.changed.trim() || !block.verified.trim() || !block.locus.trim() || !block.limitations.trim()) return null;
  const task = readTask(company, id);
  if (!task) return null;
  if (block.scope === "independent" && task.evidence?.some((e) => e.scope === "producer" && e.locus === block.locus)) return null;
  task.evidence = [...(task.evidence ?? []), { ...block, by, ts: Date.now() }];
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", `evidence ${task.id} (${block.scope}): ${task.title}`);
  return task;
}

export function markReadyForExternalReview(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task || !task.evidence?.some((e) => e.scope === "producer")) return null;
  task.readyForExternalReviewAt = Date.now();
  task.updatedTs = task.readyForExternalReviewAt;
  writeTaskRecord(task);
  emit(task, by, "task-review", `ready for external review ${task.id}: ${task.title}`);
  return task;
}

export function isReadyForExternalReview(task: TaskRecord): boolean {
  return task.state === "review" && !!task.readyForExternalReviewAt && !!task.evidence?.some((e) => e.scope === "producer");
}

/** Park on an external signal without consuming worker WIP. */
export function externalWaitTask(company: string, id: string, by: string, trigger: string): TaskRecord | null {
  if (!trigger.trim()) return null;
  const task = readTask(company, id);
  if (!task) return null;
  task.state = "external-wait";
  task.externalWaitTrigger = trigger.trim();
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", `external-wait ${task.id}: ${task.externalWaitTrigger}`);
  return task;
}

/**
 * kobo-507 — the manual way out when a card's linked PR is closed without merging
 * (superseded by a different PR/card split) and no verb can null a `pr: number`
 * field: setTaskPr only ever WRITES a number, so a stale link had no clear path
 * (the real kobo-495 case — PR #334 closed, work continued as kobo-504/kobo-506,
 * the card still says "review (PR #334)", a dead link the board can't shed).
 *
 * Deliberately narrow: clears ONLY `task.pr` (`repo`/`state` untouched — the
 * card's next lane is the reviewer/human's call, not this function's; forcing a
 * state change here would be deciding ownership this store layer doesn't own,
 * same reasoning `needAnswerTask` above uses for not auto-transitioning). `reason`
 * is MANDATORY, matching every other why-parking verb in this file (approve/
 * need-answer/reject) — a board that lets a PR link vanish silently is a board
 * lie in the other direction. Idempotent: clearing an already-unset pr is a
 * no-op, not an error (same shape as a re-sign refreshing who, not duplicating).
 *
 * Deliberately does NOT touch findTasksByPr's skip-list (done/rejected/
 * wait-for-deploy): `findTasksByPr` filters on `t.pr === pr` — once `task.pr` is
 * undefined, that comparison is false against every PR number regardless of the
 * card's state, so the missing "review" entry there is moot for THIS unstick path.
 */
export function clearTaskPr(company: string, id: string, by: string, reason: string): TaskRecord | null {
  if (!reason || !reason.trim()) return null; // mandatory — mirrors approve/need-answer/reject
  const task = readTask(company, id);
  if (!task) return null;
  if (task.pr === undefined) return task; // idempotent no-op — nothing to clear
  const priorPr = task.pr;
  delete task.pr;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", `unlinked PR #${priorPr} from ${task.id}: ${reason.trim()} — ${task.title}`);
  return task;
}

// ── kobo-327: merge-gate — 2-sign funnel enforced in software ──────────────────

export type SignTier = "crew" | "head";

/**
 * kobo-501: what justified a sign, ordered lowest to highest. "undeclared" is distinct
 * from "diff-read" on purpose — front review, c1: defaulting an omitted claim to
 * "diff-read" would collapse "nobody said anything" into "someone actively said they
 * only read the diff," the exact unknown-collapsed-into-known shape this card exists to
 * remove (isPaneAway→present, sign→success, refusal→known-outsider, buildInjectSlice→
 * nothing-to-report — all the same bug, tonight, before this one).
 */
export type SignEvidenceScope = "undeclared" | "diff-read" | "test-run" | "test-run+mutation";

// kobo-578: the canonical ORDER lives here once — the `sign` CLI validates
// --evidence against this same array instead of hardcoding a second copy (the
// whole session's recurring bug shape: a hand-maintained list drifting from its
// real source).
export const EVIDENCE_SCOPES: SignEvidenceScope[] = ["undeclared", "diff-read", "test-run", "test-run+mutation"];
export function evidenceScopeRank(scope: SignEvidenceScope): number {
  return EVIDENCE_SCOPES.indexOf(scope);
}

/** kobo-578: a snapshot of one tier's sign, either the CURRENT one (priorSignFor) or a superseded one (TaskRecord.signHistory). */
export interface SignHistoryEntry {
  role: SignTier;
  by: string;
  ts: number;
  sha?: string;
  patchId?: string;
  evidenceScope: SignEvidenceScope;
  evidenceLocus?: string;
  pane?: string;
  supersededTs: number; // when a NEW sign on the same tier overwrote this one
}

/**
 * The sign tiers a card must collect BEFORE it can be merged. Head is the final
 * gate on every gated card (single-tier = 1). A crew-cell card (`crewGate`) also
 * needs a crew pre-sign (crew-cell = 2). A card with no crewGate is NEVER
 * hard-required to have a crew sign — otherwise a plain non-crew card could never
 * merge (the kobo-327 design crux).
 */
export function requiredSignTiers(task: TaskRecord): SignTier[] {
  return task.crewGate ? ["crew", "head"] : ["head"];
}

/** Which required tiers are still unsigned (empty = ready to merge). */
export function missingSignTiers(task: TaskRecord): SignTier[] {
  return requiredSignTiers(task).filter((tier) =>
    tier === "crew" ? !task.crewSignedBy : !task.headSignedBy,
  );
}

/**
 * kobo-576: required tiers whose signed SHA disagrees with another required
 * tier's — crew and head reviewed different commits. Mirrors the EXACT
 * comparison the `merge` verb already enforces (kobo-400, task/index.ts, the
 * tierShas check right before `--match-head-commit`) before it will attempt a
 * merge — this makes that same judgment available BEFORE merge time, so a
 * status message or board display can stop calling a card ready when `merge`
 * itself would refuse it (the real pgw-368 shape: `missingSignTiers` alone
 * said "complete," never having looked at a SHA at all).
 *
 * Requires ALL required tiers' sha to be PRESENT to fire — any tier's sha
 * absent is the kobo-400 legacy-grandfather case, out of scope here (that gap
 * has its own card, kobo-404: sha=null). Deliberately does NOT compare
 * against the PR's true external current head — that external freshness
 * check already happens atomically server-side via GitHub's own
 * `--match-head-commit` at actual merge time; duplicating it here would mean
 * a live `gh` fetch on every read (the Unhappy path this card explicitly
 * warns against), for a check GitHub already performs for free at the one
 * moment it actually matters. This only catches tiers DISAGREEING WITH EACH
 * OTHER — the shape proven to matter live tonight (kobo-557).
 *
 * kobo-576 review round 1 — the gap this leaves, enumerated: both tiers
 * signing the SAME stale commit is NOT caught here (crewSignedSha ===
 * headSignedSha ⇒ `new Set(shas).size` is 1 ⇒ `[]`), even when the real PR
 * head has since moved past that commit. This happened for real on
 * 2026-07-28 (kobo-557): crew and head both signed `ae80e699`, no one did
 * anything wrong, and the head still moved to `36d7e5aa` then `4a3548fb`
 * because a sibling PR merged into alpha underneath it. The only thing that
 * catches THAT shape is `--match-head-commit` at actual merge time — this
 * function's claim is narrower than "ready to merge."
 */
export function staleSignTiers(task: TaskRecord): SignTier[] {
  const required = requiredSignTiers(task);
  const shas = required.map((tier) => (tier === "crew" ? task.crewSignedSha : task.headSignedSha));
  if (shas.some((s) => !s)) return []; // kobo-400/404 legacy grandfather — not this card's scope
  return new Set(shas).size > 1 ? required : [];
}

/**
 * kobo-546 — the ONLY place `crewGate` gets set true outside an explicit crew
 * sign/dispatch. ONE-WAY RATCHET: already `crewGate: true` is a no-op (no
 * re-note, no re-emit) — this file has no function anywhere that clears
 * `crewGate`, so a downgrade is structurally impossible, not just discouraged
 * (pinned by a source-string test: `crewGate = false` must never appear here).
 * `reason` lands on the card's own notes — a reviewer sees WHY a card became
 * 2-tier, not just that it did (who/when/which-card come free from the note).
 */
export function escalateCrewGate(company: string, id: string, by: string, reason: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.crewGate) return task; // ratchet is one-way — already 2-tier, nothing to do
  task.crewGate = true;
  const note: TaskNote = { ts: Date.now(), iso: nowIso(), by, text: `⬆ escalated to 2-tier (crew+head): ${reason}` };
  task.notes = [...(task.notes ?? []), note];
  task.updatedTs = note.ts;
  writeTaskRecord(task);
  emit(task, by, "task-updated", `⬆ ${task.id} escalated to 2-tier: ${reason}`);
  return task;
}

/**
 * kobo-546 — orchestrates classify+escalate given an ALREADY-FETCHED file list
 * (never calls gh itself — that I/O lives in the CLI caller, same convention as
 * kobo-400's sha-fetch: untestable subprocess call stays a thin wrapper, the
 * LOGIC that consumes its result is what's unit-tested). `stage` labels the
 * note/emit reason so a reviewer can tell a PR-open stamp from a merge-time
 * reclassify (rule 7: merge-time wins over stamp — calling this again at merge
 * time with a fresher `files` list is exactly how that AC is satisfied: the
 * ratchet only ever adds a tier, so a merge-time escalation sticks even though
 * PR-open already stamped 1-tier). Returns null when nothing needed escalating
 * (already 1-tier-sufficient, or already crew-gated).
 */
export function reclassifyAndEscalate(company: string, id: string, by: string, files: DiffFile[] | null, stage: "pr-open" | "merge-time"): TaskRecord | null {
  const classification = classifySignTiers(files);
  if (!classification.tiers.includes("crew")) return null;
  return escalateCrewGate(company, id, by, `${stage}: ${classification.reason}`);
}

/**
 * kobo-336: the oracle that signed BOTH tiers, if any. A crew card requires two
 * INDEPENDENT eyes (the executor≠reviewer principle, kobo-328) — one oracle filling
 * both the crew and head tier is a self-review bypass (found live in the kobo-329
 * dogfood: the merge-gate let a same-signer card through). Returns the offending
 * oracle, or null when the tiers are distinct or not both signed. A single-tier
 * head-only card has no crew signer (crewSignedBy unset) → never a match, so this
 * never over-blocks a genuine no-crew merge.
 */
export function sameSignerBothTiers(task: TaskRecord): string | null {
  return task.crewSignedBy && task.headSignedBy && task.crewSignedBy === task.headSignedBy
    ? task.crewSignedBy
    : null;
}

/**
 * kobo-346 (v2 340c): the tmux %pane-id that signed BOTH tiers, if any. A v2 crew is many
 * panes of ONE oracle (reviewer-pane, worker-pane, lead-pane all resolve to the same oracle
 * name), so kobo-336's oracle-distinct check passes for two panes of the same oracle — the
 * INTRA-oracle phantom-sign (kobo-339). This LAYERS ON TOP of sameSignerBothTiers (both hold):
 * even same-oracle, the two tiers must be signed from DISTINCT panes. Returns the offending
 * pane-id, or null when the panes are distinct OR either pane-id is absent (a non-crew / no-tmux
 * sign has no pane binding → falls back to the kobo-336 oracle-grain check; never over-blocks).
 * CEILING: the pane-id is live-resolved in the signing pane's own shell → agent-settable →
 * DEFENSE-IN-DEPTH (kills the structural/accidental phantom-sign), NOT airtight — no "unforgeable".
 */
export function samePaneBothTiers(task: TaskRecord): string | null {
  return task.crewSignedByPane && task.headSignedByPane && task.crewSignedByPane === task.headSignedByPane
    ? task.crewSignedByPane
    : null;
}

/**
 * kobo-501: the evidence-grain twin of samePaneBothTiers — catches what pane/oracle
 * checks structurally cannot: two DIFFERENT signers, from DIFFERENT panes, citing the
 * SAME verification artifact for both tiers (the actual kobo-482 shape — one mutation
 * run, credited to both). "Confirm two ways counts when the METHOD differs, not when
 * the PERSON differs" (lead's ruling, this card's own body). Returns the offending
 * locus, or null when the loci differ OR either is absent. This only bites because
 * evidenceScopeViolation (below) makes locus REQUIRED once a claim is above diff-read —
 * an optional locus would make this guard opt-in, missing the real incident, which had
 * no locus recorded on EITHER tier (front review, c1 objection 2).
 */
export function sameEvidenceLocusBothTiers(task: TaskRecord): string | null {
  const crew = task.crewSignedEvidenceLocus?.trim();
  const head = task.headSignedEvidenceLocus?.trim();
  return crew && head && crew === head ? crew : null;
}

/**
 * kobo-346 (v2 340c): the sign-time pane guard — pure so it's testable without real tmux. Given
 * the SIGNING pane-id + its CREW_ROLE (both live-resolved by the caller in the signer's shell),
 * returns a refusal reason, or null to allow. Two rules, only when a pane is present (a sign
 * OUTSIDE a tmux pane → signerPane null → returns null → the kobo-335 oracle-grain path stands):
 *   item-4 (the real kobo-339 closer): a sign is a REVIEWER act — only a reviewer-role pane may
 *     sign. This is what stops a NON-reviewer pane (a worker, or the lead .0) from signing a tier
 *     it isn't designated for — the pane-distinct check alone would pass that (lead-pane ≠ crew-pane).
 *   item-3 (belt): the two tiers must come from DISTINCT panes (same-pane both tiers → refuse).
 * CEILING: signerPane/signerRole are agent-settable (shell env / tmux query the pane runs) →
 * DEFENSE-IN-DEPTH (kills the structural phantom-sign), NEVER airtight.
 */
export function signPaneViolation(task: TaskRecord, role: SignTier, signerPane: string | null | undefined, signerRole: string | null | undefined): string | null {
  const pane = signerPane?.trim();
  if (!pane) return null; // no pane binding (not a tmux pane) → oracle-grain fallback (kobo-335)
  if ((signerRole ?? "").trim() !== "reviewer") {
    return `a ${role} sign must come from the designated reviewer pane (CREW_ROLE=reviewer) — this pane is ${signerRole?.trim() ? `"${signerRole.trim()}"` : "not a reviewer"} (kobo-346/339: only the reviewer pane signs; a worker/lead pane can't).`;
  }
  if ((role === "head" && task.crewSignedByPane === pane) || (role === "crew" && task.headSignedByPane === pane)) {
    return `pane ${pane} already signed the ${role === "head" ? "crew" : "head"} tier — a DISTINCT reviewer pane is required per tier (kobo-346). Sign ${role} from a different pane.`;
  }
  return null;
}

/**
 * kobo-501: a claim of having RUN something must say WHERE. Pure so it's testable
 * without a real sign. "undeclared" and "diff-read" need no locus (there's nothing to
 * point at); "test-run" and "test-run+mutation" REQUIRE one, non-empty. Without this,
 * evidenceLocus is opt-in free text, and sameEvidenceLocusBothTiers only catches a
 * signer who volunteers a locus — which is not what happened on the real kobo-482
 * incident (no locus recorded on either tier at all). Making locus mandatory above
 * diff-read is what makes that guard load-bearing instead of advisory (front review,
 * c1 objection 2).
 */
export function evidenceScopeViolation(scope: SignEvidenceScope, locus: string | null | undefined): string | null {
  const needsLocus = scope === "test-run" || scope === "test-run+mutation";
  if (needsLocus && !(locus ?? "").trim()) {
    return `evidence scope "${scope}" requires --evidence-locus (a claim of having run something must say where, kobo-501) — pass the worktree/path/command the evidence came from, or sign with --evidence diff-read if that's what actually happened.`;
  }
  return null;
}

/**
 * kobo-501: a distinct label per evidence tier, for board/API display — the whole point
 * of this card is that two signs must read differently at a glance, not "passed both
 * tiers" identically (kobo-470's exact pattern: different leading symbol per state, not
 * just different trailing words, since a future "unify the formatting" tidy-up could
 * quietly re-converge them otherwise).
 */
export function formatSignEvidenceScope(scope: SignEvidenceScope | undefined): string {
  switch (scope) {
    case "test-run+mutation": return "🔬 test-run+mutation";
    case "test-run": return "✅ test-run";
    case "diff-read": return "📄 diff-read";
    case "undeclared":
    case undefined:
      return "❔ undeclared";
  }
}

/** kobo-578: the CURRENT sign on a tier, in the same shape a history entry takes — null when that tier has never been signed. */
export function priorSignFor(task: TaskRecord | null | undefined, role: SignTier): Omit<SignHistoryEntry, "supersededTs"> | null {
  if (!task) return null;
  const by = role === "crew" ? task.crewSignedBy : task.headSignedBy;
  if (!by) return null;
  return {
    role,
    by,
    ts: (role === "crew" ? task.crewSignedTs : task.headSignedTs) ?? 0,
    sha: role === "crew" ? task.crewSignedSha : task.headSignedSha,
    patchId: role === "crew" ? task.crewSignedPatchId : task.headSignedPatchId,
    evidenceScope: (role === "crew" ? task.crewSignedEvidenceScope : task.headSignedEvidenceScope) ?? "undeclared",
    evidenceLocus: role === "crew" ? task.crewSignedEvidenceLocus : task.headSignedEvidenceLocus,
    pane: role === "crew" ? task.crewSignedByPane : task.headSignedByPane,
  };
}

/**
 * kobo-578: true when a re-sign of the SAME reviewed content (patch-id
 * unchanged) carries WEAKER evidence than what's already there. A SHA change
 * alone is never enough to call this — ancestry moves (a sibling PR merging
 * underneath this one) without the diff changing a single line, kobo-557 being
 * the live example the card that opened this was built against — so the unit
 * that decides "same review or not" is the diff's own hash, not the commit id
 * it's currently attached to. Both patch-ids must be KNOWN to compare; either
 * side missing means "can't tell" — never silently assumed same or different.
 */
export function isSignDowngrade(prior: Omit<SignHistoryEntry, "supersededTs"> | null, newScope: SignEvidenceScope, newPatchId: string | undefined): boolean {
  if (!prior || !prior.patchId || !newPatchId) return false;
  if (prior.patchId !== newPatchId) return false; // genuinely different content — the old evidence is moot, not a downgrade
  return evidenceScopeRank(newScope) < evidenceScopeRank(prior.evidenceScope);
}

/**
 * Record a gate sign (crew or head). Idempotent — re-signing just refreshes who+ts
 * (no error, no duplicate). A crew sign self-marks the card `crewGate` so a card a
 * crew has touched can't skip the crew tier. Returns null if the card is absent.
 *
 * kobo-400: `sha` (when known — the caller's best-effort `gh pr view --json headRefOid`)
 * binds this sign to the commit it reviewed. Re-signing always REFRESHES the field to
 * whatever the caller passed this time (including undefined on a failed re-fetch) — a
 * re-sign is a fresh act, so a stale SHA from an earlier attempt must not linger and
 * imply verification that didn't happen. Absent → `merge` grandfathers this tier.
 *
 * kobo-501: `evidenceScope` defaults to `"undeclared"` when the caller passes nothing —
 * NOT `"diff-read"`. Callers should run `evidenceScopeViolation(evidenceScope, evidenceLocus)`
 * BEFORE this and refuse on a non-null result (same pattern as `signPaneViolation`); this
 * function itself does not validate, so it stays a pure record-write, testable without
 * threading a refusal path through it.
 *
 * kobo-578: overwriting an existing sign on this tier NEVER refuses (last night alone,
 * a legitimate re-sign-after-push happened 4 times) — but it never happens silently
 * either. The sign about to be replaced is pushed onto `signHistory` first (Nothing is
 * Deleted — this is also the answer to "why is there no unsign verb": overwriting
 * doesn't erase, it just moves the current-pointer forward, so nothing needs undoing).
 * `patchId` (when known — caller's best-effort `gh pr diff` piped through `git patch-id
 * --stable`) is what `isSignDowngrade` uses to warn the CALLER loudly; this function
 * itself only records, callers decide what to print (mirrors evidenceScopeViolation).
 */
export function signTask(
  company: string, id: string, by: string, role: SignTier, pane?: string | null, sha?: string,
  evidenceScope?: SignEvidenceScope, evidenceLocus?: string | null, patchId?: string,
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const now = Date.now();
  const signerPane = pane?.trim() || undefined; // kobo-346: the signing pane (%N), when known
  const scope: SignEvidenceScope = evidenceScope ?? "undeclared"; // kobo-501: never "diff-read" by default
  const locus = evidenceLocus?.trim() || undefined;
  const prior = priorSignFor(task, role); // kobo-578: snapshot BEFORE overwrite
  if (prior) {
    task.signHistory = [...(task.signHistory ?? []), { ...prior, supersededTs: now }];
  }
  if (role === "crew") {
    task.crewSignedBy = by;
    task.crewSignedTs = now;
    task.crewSignedByPane = signerPane; // kobo-346: bind the crew tier to its signing pane
    task.crewSignedSha = sha; // kobo-400: bind the crew tier to its reviewed commit
    task.crewSignedPatchId = patchId; // kobo-578: bind the crew tier to its reviewed DIFF
    task.crewSignedEvidenceScope = scope; // kobo-501
    task.crewSignedEvidenceLocus = locus; // kobo-501
    task.crewGate = true; // a crew signing declares this a crew-tier card
  } else {
    task.headSignedBy = by;
    task.headSignedTs = now;
    task.headSignedByPane = signerPane; // kobo-346: bind the head tier to its signing pane
    task.headSignedSha = sha; // kobo-400: bind the head tier to its reviewed commit
    task.headSignedPatchId = patchId; // kobo-578: bind the head tier to its reviewed DIFF
    task.headSignedEvidenceScope = scope; // kobo-501
    task.headSignedEvidenceLocus = locus; // kobo-501
  }
  task.updatedTs = now;
  writeTaskRecord(task);
  const downgrade = isSignDowngrade(prior, scope, patchId);
  emit(task, by, downgrade ? "task-sign-downgrade" : "task-review", `sign ${task.id} (${role}): ${task.title}${downgrade ? " [DOWNGRADE: weaker evidence at unchanged reviewed content]" : ""}`);
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
 * kobo-594: record a SUCCESSFUL `gh` mergeable-state check — the caller (pr-watch)
 * only calls this when it actually got a value back; a failed/rate-limited `gh`
 * call must never call this at all, leaving the prior (possibly absent) state
 * untouched rather than writing a guess. This is the ONLY writer of these 3
 * fields — always called together so they can never desync (a status without
 * its own timestamp would be unreadable as fresh-or-stale).
 */
export function setTaskPrMergeState(company: string, id: string, mergeable: string, mergeStateStatus: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  // kobo-594 review round 1: this runs on EVERY poll (serve-pr-watch ticks every
  // 2 min) for every OPEN PR-linked card, by design — that's what makes it
  // self-heal without a manual unset. But rewriting the file + bumping a
  // timestamp on EVERY poll even when NOTHING changed means a card churns
  // (and Company Home's git diff churns) ~720x/day for zero new information.
  // Skip the write entirely — INCLUDING prMergeCheckedTs — when the value
  // didn't change. Trade-off, chosen deliberately: prMergeCheckedTs then reads
  // as "last time this CHANGED," not "last time this was re-confirmed," so a
  // long-stable MERGEABLE PR can show an old checked-time even though pr-watch
  // has silently re-confirmed it every 2 minutes since. That is the safe
  // direction to be wrong in for a merge-safety signal — it makes a fresh fact
  // look OLDER than it is (prompting a manual double-check, harmless) rather
  // than newer (which could paper over a check that actually failed silently
  // upstream). Never the other way.
  if (task.prMergeable === mergeable && task.prMergeStateStatus === mergeStateStatus) return task;
  task.prMergeable = mergeable;
  task.prMergeStateStatus = mergeStateStatus;
  task.prMergeCheckedTs = Date.now();
  // kobo-594 review round 1: deliberately NOT touching task.updatedTs here.
  // updatedTs is the same field kobo-571 is asking Tony to rule "no longer
  // trustworthy" because too many writers already bump it for reasons a human
  // reading the board doesn't care about — adding pr-watch's routine polling
  // as a new automatic writer would make that problem worse, not better, and
  // would fight its own pending resolution. prMergeCheckedTs already carries
  // this write's own freshness signal; nothing needs to borrow updatedTs.
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
  // else the creator — but NONE of them may be the doer (kobo-328: executor≠reviewer,
  // even an explicit arg. A self-review target silently downgrades to creator→human
  // rather than routing the PR review back to its own author).
  const explicit = reviewer ?? task.reviewer;
  const target = (explicit && explicit !== doer)
    ? explicit
    : (task.by && task.by !== doer ? task.by : "human");
  if (task.state === "review" && task.reviewer === target) return task; // idempotent (assignee untouched)
  task.state = "review";
  task.reviewer = target;
  task.updatedTs = Date.now();
  writeTaskWithDepGuard(task); // kobo-253 EDGE: PR opened while a dep is still pending → blocked wins
  emitDepGuardedResult(task, author, "task-review", `review ${task.id}${task.pr ? ` (PR #${task.pr})` : ""} → ${target}: ${task.title}`);
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
  // Preserve reviewer/reviewerPane/reviewerCellId and readiness as card lineage.
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

/** kobo-275 — result of markDeployedTask: success carries the done card; the two
 *  failure reasons are distinct so every surface (CLI/MCP/web) reports the same
 *  message (not_found → 404, not_waiting → refuse without doning). */
export type DeployedResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_waiting"; state: TaskState };

/**
 * kobo-275 — manual deploy-drain: flip a `wait-for-deploy` card → done. The EXIT
 * twin of the wait-for-deploy park (kobo-273 lane / kobo-274 entry). Deploy stays
 * MANUAL — no auto-detect hook (Tony rejected that, kobo-233); a human runs this
 * once the merged feature is actually live. Guarded: ONLY a card currently in
 * wait-for-deploy can be marked deployed — any other state is refused so the verb
 * can never done a card that never waited. Delegates to completeTask (the single
 * done path: emits task-done, releases claims, promotes dependents) after the guard.
 */
export function markDeployedTask(company: string, id: string, by: string): DeployedResult {
  const task = readTask(company, id);
  if (!task) return { ok: false, reason: "not_found" };
  if (task.state !== "wait-for-deploy") return { ok: false, reason: "not_waiting", state: task.state };
  const done = completeTask(company, id, by);
  if (!done) return { ok: false, reason: "not_found" }; // vanished between reads (race)
  return { ok: true, task: done };
}

/**
 * kobo-274 (epic 272 slice B) — the pr-watch MERGE flip. A **deploy-required** card
 * parks in `wait-for-deploy` (merged ≠ live — the server deploy is manual) instead of
 * going straight to `done`; slice C drains the lane to done after the deploy. A
 * non-deploy card falls through to completeTask (done) — behavior unchanged.
 *
 * deployRequired defaults to "has a linked PR" (Tony option a — a merged PR generally
 * ships code that must be deployed), overridable per card either way (a docs/test PR →
 * set false to go straight to done; a no-PR card → set true to park).
 *
 * Parking is NON-terminal, so unlike done it does NOT release claims, promote dependent
 * children, or notify the epic parent — that only happens when the card truly reaches
 * done (via the slice-C deploy exit). Manual `task done` still uses completeTask directly.
 */
export function completeOrParkMergedTask(company: string, id: string, by: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  if (task.state === "wait-for-deploy") return task; // kobo-274 — already parked: idempotent no-op (no re-write/emit), mirroring completeTask's done-guard
  const deployRequired = task.deployRequired ?? task.pr != null;
  if (!deployRequired) return completeTask(company, id, by); // non-deploy → done (unchanged)
  task.state = "wait-for-deploy";
  delete task.block; // clear any explicit block, mirroring done
  delete task.prevState;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-updated", `parked ${task.id} → wait-for-deploy (merged, awaiting deploy): ${task.title}`);
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
  task.reviewRejectCount = (task.reviewRejectCount ?? 0) + 1;
  task.state = task.reviewRejectCount >= 2 ? "need-answer" : "rejected";
  task.rejectReason = reason;
  // Preserve reviewer routing across close/reopen and record the rejection reason.
  delete task.block; // reject auto-clears an explicit block (mirrors done)
  delete task.prevState;
  task.updatedTs = Date.now();
  writeTaskRecord(task);
  emit(task, by, "task-rejected", `${task.state === "need-answer" ? "need-answer" : "rejected"} ${task.id}: ${task.title} — ${reason}`);
  releaseAllClaims(task);
  return task;
}

/** Reopen a closed card without losing its accountable owner or reviewer routing. */
export function reopenTask(company: string, id: string, by: string, state: TaskState = "todo"): TaskRecord | null {
  const task = readTask(company, id);
  if (!task || (task.state !== "done" && task.state !== "rejected")) return null;
  if (!["backlog", "todo", "ready", "review"].includes(state)) return null;
  task.state = state;
  task.updatedTs = Date.now();
  writeTaskWithDepGuard(task);
  emitDepGuardedResult(task, by, "task-updated", `reopened ${task.id} → ${task.state}: ${task.title}`);
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
 * kobo-555: kobo-229 added a CAPTURED exception here (a note auto-captured from a
 * hey mentioning this card-id never advanced state, mention ≠ work) — removed along
 * with the auto-capture feature that was its only producer (kobo-165). Every note
 * is now deliberately authored, so the plain assignee-on-todo/ready rule below is
 * sufficient again.
 */
export function noteTask(company: string, id: string, by: string, text: string): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const note: TaskNote = { ts: Date.now(), iso: nowIso(), by, text };
  task.notes = [...(task.notes ?? []), note]; // append-only — prior notes are untouched
  task.updatedTs = note.ts;
  const advance = (task.state === "todo" || task.state === "ready") && !!task.assignee && task.assignee === by;
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
 * mentions queue (pendingMentions) — kobo-237: they no longer drop out on a resolve
 * (the resolve concept is gone); the queue is trimmed by mark-as-read (kobo-238).
 */
export function commentTask(
  company: string,
  id: string,
  by: string,
  text: string,
  replyTo?: string,
  opts: { tldr?: string; ask?: string; detail?: string } = {},
): TaskRecord | null {
  const task = readTask(company, id);
  if (!task) return null;
  const existing = task.comments ?? [];
  if (replyTo && !existing.some((c) => c.id === replyTo)) {
    throw new Error(`reply target not found on ${id}: ${replyTo}`);
  }
  const comment: TaskComment = { id: `c${existing.length + 1}`, ts: Date.now(), iso: nowIso(), by, text };
  if (replyTo) comment.replyTo = replyTo;
  // kobo-265: EVERY comment carries a tldr. When --tldr isn't passed, auto-derive it from
  // the text — first line = tldr, the remaining lines = detail. The remainder MUST route to
  // `detail` because the structured render hides `text` once `tldr` is set (so multiline
  // body would vanish otherwise). Explicit --tldr / --detail always win (no clobber).
  let tldr = opts.tldr?.trim();
  let detail = opts.detail?.trim();
  if (!tldr && text.trim()) {
    const lines = text.split("\n");
    tldr = lines[0].trim();
    const rest = lines.slice(1).join("\n").trim();
    if (rest && !detail) detail = rest; // route remainder → detail (don't overwrite an explicit --detail)
  }
  if (tldr) comment.tldr = tldr;
  if (opts.ask?.trim()) comment.ask = opts.ask.trim();
  if (detail) comment.detail = detail;
  task.comments = [...existing, comment]; // append-only — prior comments untouched
  task.updatedTs = comment.ts;
  writeTaskRecord(task);
  const oneLine = text.replace(/\s+/g, " ").trim();
  emit(task, by, "task-comment", `comment ${task.id} (${comment.id}): ${oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine}`);
  return task;
}

// kobo-237: resolveComment removed — the resolve concept is gone end-to-end (CLI/MCP/
// UI verb + read/write). Legacy `resolved` fields on stored comments are kept but
// never read/written (Nothing is Deleted). The mentions queue is trimmed by
// mark-as-read (kobo-238), not by resolve.

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
      .map((n) => ({ n }))
      .filter(({ n }) => parseMentions(n.text).length > 0);
    if (!questionNotes.length) continue;
    cards++;

    const comments = [...(task.comments ?? [])];
    let migrated = 0;
    let skipped = 0;
    for (const { n } of questionNotes) {
      // idempotency: this exact note already copied? (ts + author + text)
      if (comments.some((c) => c.fromNote === n.ts && c.by === n.by && c.text === n.text)) {
        skipped++;
        continue;
      }
      // kobo-237: a migrated question-note becomes a plain comment — no resolve
      // stamping (the resolve concept is gone; the mentions queue is trimmed by
      // mark-as-read, kobo-238). The `fromNote` idempotency marker is still set.
      const comment: TaskComment = { id: `c${comments.length + 1}`, ts: n.ts, iso: n.iso, by: n.by, text: n.text, fromNote: n.ts };
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

export interface LaneReconcileOutcome {
  id: string; // card id
  company: string;
  from: TaskState; // lane before reconcile
  to: TaskState; // lane after reconcile
  action: "blocked" | "restored"; // forced off-flow, or restored to prevState
}
export interface LaneReconcileResult {
  companies: number; // companies scanned
  scanned: number; // active cards examined
  changed: number; // cards whose lane was corrected
  outcomes: LaneReconcileOutcome[];
}

/**
 * One-shot board-wide reconcile (kobo-257, epic 251 slice F). Repairs cards written
 * BEFORE the state-machine fix (kobo-252/253) that could sit in a FLOW lane
 * (review/in-progress/todo/ready) while a dep was still pending — the "2-lane"
 * board-lie (pgw-237 repro: state=review with only a derived blocked overlay). Runs
 * the SAME {@link reconcileDependencyState} the live write-path now enforces on every
 * card, so each lands on its single correct lane:
 *   - pending dep in a flow lane  → blocked (+prevState remembering the lane)
 *   - dep cleared on a dep-blocked → restored to prevState (the pre-fix backlog the
 *     live auto-promote-back never fired on)
 * Idempotent (a card already reconciled → reconcile returns null → skipped) and
 * NON-destructive (only state/prevState/block change; nothing is deleted — the
 * original lane is preserved in prevState, Principle 1). Scans ALL companies by
 * default (`opts.company` narrows to one). `dryRun` reports what WOULD change
 * without writing. Emits one worklog event per corrected card.
 *
 * Snapshot safety: the parent-state resolver is built once per company. Reconcile
 * never moves a card to done/archived, so no dep becomes newly-satisfied mid-pass —
 * the snapshot stays correct for the whole sweep.
 */
export function reconcileTwoLaneCards(
  opts: { dryRun?: boolean; by?: string; company?: string } = {},
): LaneReconcileResult {
  const dryRun = opts.dryRun ?? false;
  const actor = opts.by ?? "system";
  const companies = opts.company ? [opts.company] : listCompanies();
  const outcomes: LaneReconcileOutcome[] = [];
  let scanned = 0;

  for (const company of companies) {
    const resolve = parentStateResolver(company);
    for (const task of listTasks(company)) {
      scanned++;
      const from = task.state;
      const action = reconcileDependencyState(task, resolve);
      if (!action) continue; // already one truth — idempotent no-op
      if (!dryRun) {
        task.updatedTs = Date.now();
        writeTaskRecord(task);
        emit(task, actor, "task-updated", `reconcile ${action} ${task.id}: ${from}→${task.state} (kobo-257 migration)`);
      }
      outcomes.push({ id: task.id, company, from, to: task.state, action });
    }
  }

  return { companies: companies.length, scanned, changed: outcomes.length, outcomes };
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

/**
 * The clarity GATE for a comment (kobo-263, expanded by kobo-265). EVERY comment carries a
 * `tldr` now — but it's auto-derived from the text's first line when `--tldr` isn't passed
 * (commentTask fallback), so the tldr requirement is met by any non-empty text and needs NO
 * rejection here (the CLI already rejects empty text). What this gate still enforces: a
 * comment addressed to Tony/human (@tony/@human, canonicalized to "tony", detected across
 * text + tldr + ask + detail) MUST carry an `ask` (what Tony must do) — agent↔agent comments
 * don't. Returns an error string when the ask is missing on a human-addressed comment; else
 * null.
 */
export function commentClarityError(text: string, tldr?: string, ask?: string, detail?: string): string | null {
  const addressed = parseMentions([text, tldr, ask, detail].filter(Boolean).join(" ")).includes("tony");
  if (addressed && !ask?.trim()) {
    return "a comment to @tony/@human must include --ask <what Tony must do> (tldr is auto-derived from your text if you don't pass --tldr). same gate as need-answer --reason.";
  }
  return null;
}

export interface PendingMention {
  id: string; // card id the mention is on
  title: string;
  who: string; // canonical mentioned key (e.g. "tony")
  by: string; // who wrote the mentioning comment
  ts: number; // mention comment ts
  iso: string;
  text: string; // the mentioning comment text
  commentId: string; // the comment carrying the mention (kobo-140)
}

/**
 * Unanswered @mentions across EVERY card (kobo-126 → repointed kobo-140). Phase C
 * moved the ask/answer channel from notes to COMMENTS (Board Truth rule 10), so
 * the queue reads every COMMENT that carries an @mention. kobo-237: the resolve
 * concept is gone — the queue no longer drops a comment when it's resolved (nor
 * reads the legacy `resolved` field); it's trimmed instead by the reader's
 * mark-as-read (kobo-238). `forWho` filters to one person's queue (canonicalized,
 * so --for tony also catches @human). Read-only derivation — never mutates.
 *
 * kobo-580: does NOT gate on isOnBoard (deliberately, caller-level fix — isOnBoard
 * itself stays correct for its other callers). Rule 10 says a comment doesn't
 * close because the card is done; gating this queue by the board's 7-day done
 * window silently dropped unanswered @mentions once their card aged off (36
 * cards / 96 comments measured on kobo; review round 1 re-measured against the
 * real removal — kobo 20→116, pgw 19→294, i.e. most of the true total on both
 * boards was hidden). Only this CLI-facing function is affected — the web
 * mentions panel (company.ts pendingMentions) has computed its own client-side
 * mirror from the already-unfiltered bulk list since kobo-401 and was never
 * gated here at all; this docstring previously claimed otherwise (stale).
 *
 * kobo-580 review round 1 — a literal "don't show resolved comments" isn't
 * possible here: kobo-237 removed the resolve concept server-side entirely (the
 * `resolved` field is legacy-only, never read). The web panel's only trim is
 * kobo-238's per-browser localStorage mark-as-read, which has no CLI/MCP
 * equivalent — this function returns every unfiltered @mention every time, by
 * design, until a real per-reader read-state exists on this side too.
 */
export function pendingMentions(company: string, forWho?: string): PendingMention[] {
  const want = forWho ? mentionKey(forWho) : null;
  const out: PendingMention[] = [];
  for (const t of listTasks(company)) {
    if (!t.comments?.length) continue;
    for (const c of t.comments) {
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
  // kobo-608: skip — a comment-reply subcard is already tightly scoped under
  // one specific parent; it can't be "two people independently duplicating
  // an unrelated card" by construction.
  return addTask({ company, title: question, by, epic: parentId, assignee: mentionKey(to), skipDuplicateScopeCheck: true });
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
  // Skip states pr-watch has ALREADY settled, so a later merge poll never re-processes
  // them: done + rejected are terminal (kobo-99/101 resurrection guard), and
  // wait-for-deploy is the merge-park (kobo-274) — re-returning it would re-park every
  // reconcile poll (updatedTs bump + duplicate "parked" event = board thrash). Slice C
  // drains it to done via a different path, not another merge flip.
  return listTasks(company).filter(
    (t) => t.pr === pr && t.state !== "done" && t.state !== "rejected" && t.state !== "wait-for-deploy" && (!repo || !t.repo || t.repo === repo),
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

/** Minutes since `ts`, floored — used only to label a cached check's staleness inline. */
function minutesAgo(ts: number): number {
  return Math.max(0, Math.floor((Date.now() - ts) / 60_000));
}

/**
 * kobo-594: the review-state next-action's PR-linked branch used to read
 * `task.pr` alone as "ready — just needs a merge click," with nothing checking
 * whether the PR was ACTUALLY mergeable on GitHub. `task.prMergeable` (written by
 * pr-watch, see setTaskPrMergeState) is the only real signal — absent means it
 * was never successfully checked (a failed/rate-limited `gh` call leaves it
 * untouched, never a guessed value), and that case must read as "don't know,"
 * never silently as "ready" (the unhappy-path AC this card exists to close).
 * Every branch that DOES have a value shows when it was checked so a stale
 * cache reads as stale, not as fresh.
 */
function prMergeNextAction(task: TaskRecord): string {
  const pr = task.pr;
  if (task.prMergeable === "CONFLICTING") {
    const checked = task.prMergeCheckedTs ? ` (เช็คล่าสุด ${minutesAgo(task.prMergeCheckedTs)} นาทีที่แล้ว)` : "";
    return `⚠ PR #${pr} conflict — ต้องแก้ conflict ก่อน merge${checked}`;
  }
  if (task.prMergeable === "MERGEABLE") {
    const checked = task.prMergeCheckedTs ? ` (เช็คล่าสุด ${minutesAgo(task.prMergeCheckedTs)} นาทีที่แล้ว)` : "";
    return `รอ merge PR #${pr} → done${checked}`;
  }
  // kobo-594 review round 2 (eq3's c5, real bug found via a live render, not a
  // diff read): "never checked" and "checked, GitHub itself hadn't finished
  // computing it" are DIFFERENT facts and must be 3 distinct states, not 2 —
  // exactly the "unknown must be its own state, never collapsed into either
  // side" rule this whole card's ancestry (557/576/594) has held all night.
  // task.prMergeCheckedTs is the ONLY thing that tells them apart: absent =
  // genuinely never checked; present + prMergeable === "UNKNOWN" = a real
  // check ran and GitHub's own lazy-compute hadn't resolved yet.
  //
  // kobo-594 review round 3 (undeclared mutation, caught by the reviewer):
  // `&& task.prMergeCheckedTs` is NOT redundant, even though setTaskPrMergeState
  // — the only writer today — always sets prMergeable and prMergeCheckedTs
  // together, so a prMergeable==="UNKNOWN" with no timestamp can't happen via
  // the real write path right now. That's an invariant held by "there happens
  // to be exactly one writer," not by anything this function itself enforces
  // — a future second writer (a migration, a manual repair script, a legacy
  // record) could set one field without the other with zero warning here. Without
  // this guard, minutesAgo(undefined) computes `Date.now() - undefined` = NaN,
  // silently printing "NaN นาทีที่แล้ว" while still claiming "เช็คแล้ว" (checked)
  // — the exact "system reports something it can't verify" defect this card
  // exists to close, just moved one field over. Do not delete this guard as
  // "dead code" without re-deriving why it's here.
  if (task.prMergeable === "UNKNOWN" && task.prMergeCheckedTs) {
    return `รอ merge PR #${pr} → done (เช็คแล้วแต่ GitHub ยังไม่สรุปสถานะ conflict — เช็คล่าสุด ${minutesAgo(task.prMergeCheckedTs)} นาทีที่แล้ว, อย่ากด merge โดยไม่เช็ค gh ด้วยมือ)`;
  }
  return `รอ merge PR #${pr} → done (ยังไม่เคยเช็คสถานะ conflict — อย่ากด merge โดยไม่เช็ค gh ด้วยมือ)`;
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
    case "review": {
      // kobo-576: "รอ merge" used to be unconditional the moment a PR was
      // linked, regardless of whether the tiers that signed it actually agree
      // on which commit they reviewed — the same tierSha mismatch `merge`
      // itself refuses on (kobo-400). This is a DIFFERENT problem than kobo-594's
      // PR-mergeable check below (a person must re-sign vs the PR's code needs
      // fixing) and takes priority: a stale signature means merge will refuse
      // regardless of the PR's own mergeable state, so check it first.
      const stale = staleSignTiers(task);
      if (task.pr && stale.length) return `⚠ เซ็นคนละ commit (${stale.join(" + ")}) — merge จะปฏิเสธ ต้องเซ็นใหม่ก่อน`;
      // kobo-594: tiers agreeing (above) is a DIFFERENT question from whether the
      // PR is actually mergeable on GitHub right now — see prMergeNextAction.
      if (task.pr) return prMergeNextAction(task);
      return `รอ ${task.reviewer || "ใครก็ได้"} ตรวจ${task.reviewReason ? ` (${task.reviewReason})` : ""}`;
    }
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
    case "wait-for-deploy":
      return "merged ✓ — รอ deploy ขึ้น live (kobo-273)";
    case "external-wait":
      return `รอสัญญาณภายนอก${task.externalWaitTrigger ? ` (${task.externalWaitTrigger})` : " (ไม่ระบุ trigger)"}`;
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

// kobo-402: lastActivityByOracle used to re-read + re-parse the WHOLE worklog
// file (unbounded, append-only — 7.9MB/34,728 lines observed on kobo) from
// scratch on every /api/tasks poll, just to derive a handful of numbers
// (median 50ms, max 297.8ms measured — the single biggest contributor to that
// endpoint's synchronous blocking). Cached below, keyed by the resolved file
// path with its byte size as the validity check — the log is append-only, so
// an unchanged size means unchanged content, no time-based staleness window.
// Bounded (one entry per company/path, updated in place, never accumulates).
const activityByOracleCache = new Map<string, { size: number; map: Record<string, number> }>();

/** Test-only — drop cached worklog-derived maps (kobo-402; data dir varies in tests). */
export function _resetActivityByOracleCache(): void {
  activityByOracleCache.clear();
}

/**
 * Newest worklog ts per oracle (mawjs-5 backstop). Excludes 'idle' — a pane-state
 * signal fired every turn-end, not real work — so an owner who wandered off reads
 * as silent even while the pane heartbeats. Read once, reused across every card.
 */
export function lastActivityByOracle(company: string | null | undefined): Record<string, number> {
  const { path, size } = worklogCacheProbe(company);
  const cached = activityByOracleCache.get(path);
  if (cached && cached.size === size) return cached.map;
  const map: Record<string, number> = {};
  for (const e of readWorklog(company, { excludeKinds: ["idle"] })) {
    if (e.oracle && (map[e.oracle] === undefined || e.ts > map[e.oracle])) map[e.oracle] = e.ts;
  }
  activityByOracleCache.set(path, { size, map });
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
  blockedBy: string[]; // parents not yet done/archived/wait-for-deploy → they block the child
  missing: string[]; // parent ids that resolve to nothing → satisfied, but surfaced faintly
}

/**
 * Derived blocked-by-dependency (ADR 0003 A) — computed at board read, NEVER
 * stored (same pattern as wait-for / next-action). 1 hop only: we never traverse
 * a parent's own parents, which keeps it loop-safe by construction. A parent
 * satisfies the child when it's `done`, `archived`, OR `wait-for-deploy` (kobo-393:
 * merged-but-not-live — the code is done, only a manual ops step remains, and the
 * state self-resolves via deploy-drain). `rejected` is deliberately NOT satisfied
 * (kobo-395: a rejected parent means the dep never happened — a separate,
 * worse "stuck forever" case, tracked on its own card). A parent that can't be
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
    if (st === "done" || st === "archived" || st === "wait-for-deploy") continue; // satisfied
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
/**
 * kobo-394 — human-readable "why" for a dependency block, so a caller/CLI echo can
 * report the REAL reason instead of a bare "blocked". Names every still-pending
 * parent + its state, e.g. "parent kobo-12 (wait-for-deploy)" or, for more than
 * one, "parent kobo-12 (wait-for-deploy), kobo-9 (in-progress)".
 */
function dependencyBlockReason(blockedBy: string[], resolve: (id: string) => ParentState): string {
  const parts = blockedBy.map((id) => `${id} (${resolve(id) ?? "?"})`);
  return `parent ${parts.join(", ")}`;
}

function reconcileDependencyState(
  task: TaskRecord,
  resolve: (id: string) => ParentState,
): "blocked" | "restored" | null {
  const blockedBy = dependencyBlock(task, resolve).blockedBy;
  const pending = blockedBy.length > 0;
  if (pending) {
    // enter only from an actionable flow state; never touch an explicit or an
    // already-dependency block (leave its prevState + kind intact). kobo-253 (slice B)
    // adds "review" to the enter set: a card sitting in review with an OPEN PR but a
    // STILL-pending dep must leave review → blocked (PR green, dep-waiting; blocked wins).
    if (task.state !== "todo" && task.state !== "ready" && task.state !== "in-progress" && task.state !== "review") return null;
    task.prevState = task.state;
    task.state = "blocked";
    task.block = { kind: "dependency", reason: dependencyBlockReason(blockedBy, resolve) };
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
 * Children that are NOT settled — the set that blocks archiving (guard a) and drives
 * the done-confirm prompt (guard b — the store allows the close, the caller
 * confirms). Settled = `done` OR `rejected`.
 *
 * kobo-642: widened from `!== "done"` alone. `rejected` is a real terminal
 * disposition ("done but not accepted", TaskState doc) that will never become
 * `done` — counting it as still "open" made an epic with a rejected child
 * permanently unarchivable, with no path out. Verified live on the real board
 * (not hypothetical): kobo-239, kobo-227, kobo-65 are stuck exactly this way today
 * (kobo-239/kobo-227 already `done` but can't archive; kobo-65 already `rejected`
 * itself, same problem one level up). This fix is monotonic — it only REMOVES
 * cards from the open-set, so it can unblock an epic but never newly block one;
 * verified against all 25 epics on the kobo board that these are the only 3
 * affected. Everything else that was genuinely open (blocked/in-progress/etc)
 * still blocks, on purpose — this only settles `rejected`.
 *
 * NOTE (kobo-642, impact this widening has WITHOUT any other file changing):
 * `handleTaskDoneRequest` (route.ts) calls this same function for its web
 * done-confirm gate. A rejected-only-blocked epic will stop triggering that
 * 409 needsConfirm prompt — and the `openChildren` id list the web UI shows
 * inside that prompt will also stop listing rejected children. That's a real,
 * user-visible behavior change on the web surface, shipping the moment THIS
 * commit merges — not a route.ts edit, but a change to what route.ts computes.
 */
export function openEpicChildren(id: string, cards: TaskRecord[]): TaskRecord[] {
  return epicChildren(id, cards).filter((c) => c.state !== "done" && c.state !== "rejected");
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
  // kobo-608 review round 2: read the board ONCE and reuse it both for the
  // idempotent-skip check below and every child's duplicate-scope check —
  // decomposeEpic used to implicitly pay listTasks(company) once per child
  // (measured ≈91ms/518 cards; a 10-child decompose = +1s of pure re-reading
  // for no new information, since same-batch siblings are excluded from the
  // scope check by BATCH_WINDOW_MS regardless of whether they're in the
  // snapshot — a slightly-stale list here changes nothing observable).
  const allOpenCards = listTasks(company);
  // Existing titles under the epic → idempotent skip (re-run safety).
  const existing = new Map(epicChildren(epicId, allOpenCards).map((c) => [c.title, c.id] as const));
  // index → created/existing id, so a `$N` sibling ref resolves even to a skipped child.
  const idByIndex: (string | null)[] = children.map(() => null);

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const title = child.title?.trim();
    if (!title) { result.failed = { index: i, title: child.title ?? "", error: "child title is required" }; return result; }
    const already = existing.get(title);
    if (already) { result.skipped.push({ index: i, id: already, title }); idByIndex[i] = already; continue; }
    try {
      const card = addTask({ company, by, title, epic: epicId, body: child.body, assignee: child.assignee ?? null, reviewer: child.reviewer, openCardsForScopeCheck: allOpenCards });
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
