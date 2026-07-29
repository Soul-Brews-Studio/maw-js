/**
 * Tasks read route (Web Request → Response), registered by the watch plugin's
 * serve hook. Behind auth via the "/tasks" entry in elysia-auth PROTECTED
 * (loopback UI bypasses; LAN must auth) — the board reveals who-works-on-what
 * within a company (Rule 6).
 *
 *   GET /api/tasks?company=<name> → { company, tasks: [ TaskCard, … ] }
 *
 * Reads the real file-per-card store (ADR 0001 §6) — companies/<c>/tasks/*.json.
 * The card shape is the locked contract (spec §6) plus the ADR fields (5-state
 * lifecycle + blocked/block). wait-for is NOT returned — the board
 * derives it (by≠assignee · state≠done). Read-only.
 */

import { addTask, archiveTask, assignTask, checklistProgress, commentTask, completeTask, dependencyBlock, editTask, epicRollup, EpicArchiveBlockedError, familyNotes, isSelfReview, isStaleDecisionCard, lastActivityByOracle, listTasks, markDeployedTask, needsOwner, noteTask, openEpicChildren, parentStateResolver, parseMentions, readTask, ReassignFrictionError, rejectTask, resolveReviewer, setTaskEpic, taskNextAction, type ChecklistProgress, type DependencyBlock, type FamilyNote, type ParentState, type TaskKind, type TaskRecord } from "./store";
import { notifyCommentReply, notifyTaskComment } from "./notify";

export interface TaskCard {
  id: string;
  title: string;
  dept: string | null;
  epic: string | null;
  state: TaskRecord["state"];
  assignee: string | null;
  repo?: string;
  pr?: number;
  prMergeable?: string; // kobo-594: raw GitHub mergeable value ("MERGEABLE"|"CONFLICTING"|"UNKNOWN") — absent = never successfully checked, must not read as ready
  prMergeStateStatus?: string; // kobo-594: raw GitHub mergeStateStatus value — richer than prMergeable alone
  prMergeCheckedTs?: number; // kobo-594: epoch ms of the last successful check — lets the UI show staleness, not just a value
  block?: TaskRecord["block"]; // off-flow block {kind,reason,for} (ADR 0003 B)
  reviewer?: string;
  crewGate?: boolean; // kobo-327: merge needs a crew pre-sign too (crew-cell card)
  crewSignedBy?: string; // kobo-327: who crew-signed (pre-PR gate)
  crewSignedTs?: number;
  crewSignedByPane?: string; // kobo-346: the pane that crew-signed (pane-grain identity)
  crewSignedEvidenceScope?: TaskRecord["crewSignedEvidenceScope"]; // kobo-501: what justified the crew sign
  crewSignedEvidenceLocus?: string; // kobo-501: where that evidence was produced (required above diff-read)
  crewSignedSha?: string; // kobo-400/kobo-510: the commit the crew tier reviewed
  headSignedBy?: string; // kobo-327: who head-signed (final gate)
  headSignedTs?: number;
  headSignedByPane?: string; // kobo-346: the pane that head-signed
  headSignedEvidenceScope?: TaskRecord["headSignedEvidenceScope"]; // kobo-501
  headSignedEvidenceLocus?: string; // kobo-501
  headSignedSha?: string; // kobo-400/kobo-510: the commit the head tier reviewed
  by: string;
  ts: number;
  updatedTs?: number;
  nextAction: string; // "what next + who" — computed, always present (Track 4)
  checklist?: ChecklistProgress; // derived N/M from body markdown (ADR 0003 C); absent when none
  dependency?: DependencyBlock; // derived blocked-by-dependency (ADR 0003 A) — present only when blockedBy/missing non-empty. NOTE: derived, NOT state==="blocked"
  // kobo-401: body/notes/comments/familyNotes are a DETAIL-panel concern (card-open
  // only) — they used to ride along on EVERY card of the bulk list fetch, ballooning
  // /api/tasks (7.3MB → sub-500KB target, measured: notes 3.99MB/familyNotes
  // 0.81MB/comments 0.70MB of it). The list response now ships slim derived fields
  // instead (below); the full fields are passthrough ONLY on the single-card detail
  // fetch (GET /api/tasks/detail, handleTaskDetailRequest).
  body?: string; // raw markdown body — detail-fetch only (was passthrough on every list card)
  notes?: TaskRecord["notes"]; // full notes timeline — detail-fetch only
  comments?: TaskRecord["comments"]; // full comment thread — detail-fetch only
  needsOwner?: true; // derived (eq3-011 kobo-14): todo + unassigned → off-flow "needs an owner". Absent otherwise.
  kind?: TaskRecord["kind"]; // "epic" for a container card (kobo-45) — absent for a normal task
  // familyNotes (kobo-46) was a client-server naming mismatch (client always read
  // task.childNotes, server always sent task.familyNotes) — the client never
  // actually consumed it. Dropped entirely (kobo-401 grep-gate: zero consumers).
  // The real epic-modal "notes from subtasks" feature is served as `childNotes` on
  // the detail-fetch response instead (see handleTaskDetailRequest).
  stale?: true; // derived (mawjs-5): in-progress + no-PR + owner worklog silent → "⏳ stuck? ball on?" soft badge. Visual only, never a state.
  // List-only slim fields (kobo-401) — cover what the board grid actually renders
  // per card without shipping the full arrays: latest-note preview + unread-dot
  // (company.ts:1071-1098, 147-153) and the @mentions decision queue
  // (company.ts:2002-2010, 2205-2211).
  lastNote?: { by: string; ts: number; text: string }; // latest note, text capped 200ch (card-face preview is visually clipped anyway, no hover-title consumer)
  maxActivityTs?: number; // max(ts) across notes+comments — drives the unread-dot without shipping the arrays
  mentionComments?: { id: string; by: string; ts: number; text: string; mentions: string[] }[]; // comments carrying an @mention, text FULL (renderMentions:2026 sets title=full text for hover — truncating breaks that)
  commentCount?: number; // total comment count — family-tree row badge (company.ts:1426) needs a count, not the full thread, on every sibling in the tree
}

const LAST_NOTE_TEXT_MAX_CHARS = 200;

function toCard(t: TaskRecord, resolveParent: (id: string) => ParentState, cards: TaskRecord[], stale = false, detail = false, includeNotes = true): TaskCard {
  const card: TaskCard = {
    id: t.id,
    title: t.title,
    dept: t.dept ?? null,
    epic: t.epic ?? null,
    state: t.state,
    assignee: t.assignee ?? null,
    by: t.by,
    ts: t.ts,
    nextAction: taskNextAction(t),
  };
  if (t.repo) card.repo = t.repo;
  if (t.pr) card.pr = t.pr;
  // kobo-594: pass through whatever's REALLY stored, including absent — same
  // discipline as the sign-evidence fields below (kobo-501 comment) — a card whose
  // PR mergeable state was never successfully checked must stay visibly absent
  // here, never defaulted, so the UI can't accidentally read "no data" as "clean".
  if (t.prMergeable) {
    card.prMergeable = t.prMergeable;
    card.prMergeStateStatus = t.prMergeStateStatus;
    card.prMergeCheckedTs = t.prMergeCheckedTs;
  }
  if (t.block) card.block = t.block;
  // kobo-328: expose the RESOLVED reviewer (never the executor) so the board shows
  // who's ACTUALLY up to review — UI↔CLI parity (Board Truth #7). Falls to "human"
  // when no independent reviewer exists; omitted then, matching the old unset UX.
  const rv = resolveReviewer(t);
  if (rv !== "human") card.reviewer = rv;
  // kobo-327: expose merge-gate sign state so the board UI matches the CLI (Board Truth #7)
  if (t.crewGate) card.crewGate = true;
  // kobo-501: pass through whatever's REALLY stored, including absent — a pre-kobo-501
  // sign has neither field written at all, and that absence must stay visibly distinct
  // from "undeclared" (every NEW sign always writes one of the 4 real values, never
  // omits it) — defaulting a missing field here would silently upgrade an old sign the
  // exact way the whole card exists to prevent, just moved from signTask to this route.
  // kobo-510: crewSignedSha/headSignedSha (kobo-400) had NEVER been copied here either —
  // a gap that predates and is independent of kobo-501's evidence-scope fields (verified:
  // 501's diff only touches Evidence* fields, never Sha fields). The board needs both SHAs
  // to show a signature is stale (crew and head reviewed different commits) — the same
  // comparison the merge-gate itself already refuses on (kobo-400), just surfaced visually
  // before someone attempts to merge.
  if (t.crewSignedBy) {
    card.crewSignedBy = t.crewSignedBy; card.crewSignedTs = t.crewSignedTs;
    if (t.crewSignedByPane) card.crewSignedByPane = t.crewSignedByPane; // kobo-346: pane parity
    if (t.crewSignedEvidenceScope) card.crewSignedEvidenceScope = t.crewSignedEvidenceScope;
    if (t.crewSignedEvidenceLocus) card.crewSignedEvidenceLocus = t.crewSignedEvidenceLocus;
    if (t.crewSignedSha) card.crewSignedSha = t.crewSignedSha;
  }
  if (t.headSignedBy) {
    card.headSignedBy = t.headSignedBy; card.headSignedTs = t.headSignedTs;
    if (t.headSignedByPane) card.headSignedByPane = t.headSignedByPane;
    if (t.headSignedEvidenceScope) card.headSignedEvidenceScope = t.headSignedEvidenceScope;
    if (t.headSignedEvidenceLocus) card.headSignedEvidenceLocus = t.headSignedEvidenceLocus;
    if (t.headSignedSha) card.headSignedSha = t.headSignedSha;
  }
  if (t.updatedTs) card.updatedTs = t.updatedTs;
  const progress = checklistProgress(t.body);
  if (progress) card.checklist = progress;
  if (detail) {
    // Single-card detail fetch (card-open) — full passthrough, same shape the list
    // endpoint used to ship on every card (kobo-401).
    if (t.body) card.body = t.body;
    // kobo-538: notes/comments scale with a card's whole history (kobo-446 has 434
    // notes → 1.5MB) — the room's lightweight card-ref preview (openCardModal in
    // room.ts) only ever renders id/title/state/assignee/body, never notes/comments,
    // so it opts OUT via includeNotes=false (?notes=0). The board's own detail modal
    // (company.ts) still needs the full thread — unset/any-other-value keeps the
    // original always-include behavior, so that caller needs no change.
    if (includeNotes) {
      if (t.notes?.length) card.notes = t.notes;
      if (t.comments?.length) card.comments = t.comments;
    }
  } else {
    // Bulk list fetch — slim derived fields only (kobo-401).
    if (t.notes?.length) {
      const n = t.notes[t.notes.length - 1];
      const text = n.text.length > LAST_NOTE_TEXT_MAX_CHARS ? n.text.slice(0, LAST_NOTE_TEXT_MAX_CHARS - 1) + "…" : n.text;
      card.lastNote = { by: n.by, ts: n.ts, text };
    }
    let maxTs = 0;
    for (const n of t.notes ?? []) if (n.ts > maxTs) maxTs = n.ts;
    for (const c of t.comments ?? []) if (c.ts > maxTs) maxTs = c.ts;
    if (maxTs) card.maxActivityTs = maxTs;
    // kobo-401: comments carrying an @mention (any target), text kept FULL —
    // renderMentions (company.ts:2028) sets title=full text for hover, truncating
    // would break that.
    const mentionComments = (t.comments ?? [])
      .map((c) => ({ id: c.id, by: c.by, ts: c.ts, text: c.text, mentions: parseMentions(c.text) }))
      .filter((c) => c.mentions.length > 0);
    if (mentionComments.length) card.mentionComments = mentionComments;
    if (t.comments?.length) card.commentCount = t.comments.length; // company.ts:1426 family-tree row badge (💬 N) — a count, not the thread
  }
  if (needsOwner(t)) card.needsOwner = true; // derived needs-owner block (eq3-011 kobo-14)
  // Derived dependency detail (ADR 0003 A) — reuse the SAME store helper the CLI
  // board uses, so web + CLI never disagree. Emitted only when there's something to
  // show (which parents block / are missing). kobo-223: the dependency block is now
  // ALSO a real persisted state (state="blocked", block.kind="dependency") — this
  // derived field carries the WHICH-parents detail alongside that state.
  const dep = dependencyBlock(t, resolveParent);
  if (dep.blockedBy.length || dep.missing.length) card.dependency = dep;
  if (t.kind) card.kind = t.kind; // "epic" (kobo-45) — task default is left absent
  if (stale) card.stale = true; // soft stuck-decision badge (mawjs-5) — visual only
  return card;
}

export function handleTasksRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, tasks: [] });
  const resolveParent = parentStateResolver(company); // active state | "archived" | null — shared across the board
  const cards = listTasks(company);
  // stuck-decision badge (mawjs-5 backstop) — derived at read, one worklog scan for all cards
  const activity = lastActivityByOracle(company);
  const now = Date.now();
  return Response.json({ company, tasks: cards.map((t) => toCard(t, resolveParent, cards, isStaleDecisionCard(t, t.assignee ? activity[t.assignee] : undefined, now))) });
}

/**
 * GET /api/tasks/detail?company=&id= — single-card detail fetch (kobo-401). The
 * bulk list (handleTasksRequest) no longer ships body/notes/comments on every
 * card; the board calls this on card-open instead. Also carries `childNotes`
 * (kobo-47 epic parent modal) for epic cards — the client already reads
 * `task.childNotes` (company.ts:852) but the list card never populated it under
 * that name (a pre-existing naming mismatch vs the old `familyNotes` field); wiring
 * it here on the detail path is a necessary fix, not scope creep — the client-side
 * fallback that used to paper over the mismatch derived child notes from sibling
 * cards' own `.notes` in the bulk list, which no longer exist there post-kobo-401.
 */
export function handleTaskDetailRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  const id = url.searchParams.get("id");
  if (!company || !id) return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  // kobo-538: ?notes=0 opts OUT of notes/comments/childNotes — the room's card-ref
  // preview modal (openCardModal) never renders them. Any other value (including
  // absent, the default) keeps the original always-include behavior unchanged —
  // the board's own detail modal (company.ts) needs the full thread and doesn't
  // pass this param.
  const includeNotes = url.searchParams.get("notes") !== "0";
  const resolveParent = parentStateResolver(company);
  const cards = listTasks(company);
  const t = cards.find((c) => c.id === id);
  if (!t) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  const activity = lastActivityByOracle(company);
  const now = Date.now();
  const card = toCard(t, resolveParent, cards, isStaleDecisionCard(t, t.assignee ? activity[t.assignee] : undefined, now), true, includeNotes) as TaskCard & { childNotes?: FamilyNote[] };
  if (includeNotes && t.kind === "epic") {
    const fam = familyNotes(t.id, cards);
    if (fam.length) card.childNotes = fam;
  }
  return Response.json({ ok: true, task: card });
}

/**
 * POST /api/tasks/note — append a comment from the web board (kobo-46 §Comment).
 * Tony types in the card modal; body { company, id, text } → noteTask(by="tony"),
 * the web board being Tony's surface (spec: "Tony พิมพ์จาก web, by=tony"). A
 * comment by someone other than the assignee pokes the assignee on the
 * task-events channel (comment = poke). Behind auth via PROTECTED POST "/tasks/…"
 * (loopback UI bypasses; LAN must auth).
 *
 * ponytail: id travels in the body (not a `:id` path param) to match the sibling
 * POST /api/tasks/archive — the http router registers exact paths, no param seam.
 *
 * Body: { company, id, text } → { ok:true, id, notes } | { ok:false, error }.
 */
export async function handleTaskNoteRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown; text?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown; text?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company : "";
  const id = typeof body.id === "string" ? body.id : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!company || !id || !text) {
    return Response.json({ ok: false, error: "company, id, and text are required" }, { status: 400 });
  }
  const by = "tony"; // the web board is Tony's surface (spec §Comment)
  const task = noteTask(company, id, by, text);
  if (!task) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  notifyTaskComment(task, by, text, "note"); // note = poke assignee (non-author only, task-events → coord pane)
  return Response.json({ ok: true, id: task.id, notes: task.notes });
}

/**
 * POST /api/tasks/comment — add a threaded comment from the web board (kobo-141).
 * The ask/answer channel (Board Truth rule 10), distinct from notes: a comment can
 * reply (`replyTo`) and be resolved, and an @mention keeps it in the mentions queue
 * until resolved. `by` is "tony" (the web board is Tony's surface, mirrors the note
 * route). A comment by someone other than the assignee pokes the assignee. Reuses
 * c1's commentTask (append-only, thread-guarded) — no parallel writer.
 *
 * Body: { company, id, text, replyTo? } → { ok:true, id, comments } | { ok:false, error }.
 * A `replyTo` that names a comment not on this card → 400 (no dangling threads).
 */
export async function handleTaskCommentRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown; text?: unknown; replyTo?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown; text?: unknown; replyTo?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company : "";
  const id = typeof body.id === "string" ? body.id : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const replyTo = typeof body.replyTo === "string" && body.replyTo.trim() ? body.replyTo.trim() : undefined;
  if (!company || !id || !text) {
    return Response.json({ ok: false, error: "company, id, and text are required" }, { status: 400 });
  }
  const by = "tony"; // the web board is Tony's surface (spec §Comment)
  let task: TaskRecord | null;
  try {
    task = commentTask(company, id, by, text, replyTo);
  } catch (e) {
    // c1 throws when replyTo names a comment that isn't on this card — a client bug,
    // not a server fault, so surface it as 400 rather than a bare 500.
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "reply target not found" }, { status: 400 });
  }
  if (!task) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  notifyTaskComment(task, by, text, "comment"); // comment = poke assignee / review-chain fallback (task-events → coord pane)
  // kobo-156: a reply also pings the parent comment's author (thread reaches the
  // person answered, not just the assignee). Tony's board reply is the main case.
  if (replyTo) notifyCommentReply(task, replyTo, by);
  return Response.json({ ok: true, id: task.id, comments: task.comments });
}

// kobo-237: POST /api/tasks/resolve removed — the resolve concept is gone
// end-to-end. The mentions queue is trimmed by the reader's mark-as-read (kobo-238),
// not by resolving a comment. Legacy `resolved` fields on stored comments are kept
// but never read/written.

/**
 * POST /api/tasks/archive — per-card archive from the web board (kobo-35). The
 * board shows an "archive" button on each done card; clicking it means "Tony
 * reviewed this and signs it off". Archiving MOVES tasks/<id>.json →
 * tasks/archive/<id>.json (principle 1 — preserved, git-tracked, never deleted),
 * so the very next GET /api/tasks no longer returns it (UI ↔ store stay in sync).
 * Behind auth via PROTECTED "/tasks" (loopback UI bypasses; LAN must auth).
 *
 * Body: { company: string, id: string } → { ok: true, id, title } | { ok:false, error }.
 * `by` is "web" — the actor on this surface is a human at the board, not an oracle.
 */
export async function handleTaskArchiveRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (!company || !id) {
    return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  }
  // Guard a (kobo-45): archiving an epic with still-open children throws
  // EpicArchiveBlockedError. Surface it as 409 + the blocking child ids so the
  // web board can show "can't archive — N children still open" (kobo-48 guard UX)
  // instead of a bare 500.
  let archived: TaskRecord | null;
  try {
    archived = archiveTask(company, id, "web");
  } catch (e) {
    if (e instanceof EpicArchiveBlockedError) {
      return Response.json({ ok: false, error: e.message, blockedBy: e.activeChildren }, { status: 409 });
    }
    throw e;
  }
  if (!archived) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  return Response.json({ ok: true, id: archived.id, title: archived.title });
}

/**
 * POST /api/tasks/create — create a card from the web board (kobo-48 §Web write).
 * The card modal's "+ subtask" button posts { company, title, epic } to make a
 * child card (epic = the parent's id → c1 containment). `by` is "tony" — the web
 * board is Tony's surface (mirrors the note/archive endpoints). A fresh id can't
 * form a containment loop (its id is new), so no loop check is needed here.
 * Behind auth via PROTECTED POST "/tasks/…" (loopback UI bypasses; LAN must auth).
 *
 * Validation (trust boundary — this is a NEW web write surface): title required +
 * trimmed + length-capped; kind coerced to the "epic"|undefined enum. The epic
 * PARENT is set through c1's loop-guarded setTaskEpic (REUSED, not reimplemented)
 * so a self/ancestor cycle → 409. A fresh id normally can't cycle, but a caller
 * passing epic = the just-allocated id would self-loop — setTaskEpic catches it.
 * An unresolvable epic id is allowed (renders as a plain tag — c1 backward-compat).
 *
 * Body: { company, title, epic?, kind? } → { ok:true, task } | { ok:false, error }.
 */
const MAX_TITLE_LEN = 500;

export async function handleTaskCreateRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; title?: unknown; epic?: unknown; kind?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; title?: unknown; epic?: unknown; kind?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const epic = typeof body.epic === "string" && body.epic.trim() ? body.epic.trim() : undefined;
  const kind: TaskKind | undefined = body.kind === "epic" ? "epic" : undefined; // only "epic" is meaningful; task is the default
  if (!company || !title) {
    return Response.json({ ok: false, error: "company and title are required" }, { status: 400 });
  }
  if (title.length > MAX_TITLE_LEN) {
    return Response.json({ ok: false, error: `title too long (max ${MAX_TITLE_LEN})` }, { status: 400 });
  }
  // Create the card, then attach the containment parent through c1's loop-guarded
  // setter. On a cycle it throws → 409 (the card is still created, just unparented
  // — a valid standalone card; the only trigger is a pathological epic = own id).
  const task = addTask({ company, title, by: "tony", kind });
  let created = task;
  if (epic) {
    try {
      const parented = setTaskEpic(company, task.id, epic, "tony");
      if (parented) created = parented;
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : "epic loop rejected" }, { status: 409 });
    }
  }
  return Response.json({ ok: true, task: { id: created.id, title: created.title, epic: created.epic ?? null, state: created.state } });
}

/**
 * POST /api/tasks/done — mark a card done from the web board (kobo-50, item 1).
 * Gives c1's guard b ("done an epic whose children aren't all finished → allow +
 * CONFIRM") its missing web trigger. The store guard is REUSED (openEpicChildren /
 * epicRollup), not reimplemented:
 *   - a card with open (not-done) children AND no { confirm:true } → 409
 *     { needsConfirm:true, rollup:{done,total}, openChildren:[ids] } so the UI can
 *     ask "children N/M — close anyway?" before collapsing the scope.
 *   - confirm:true (or no open children) → completeTask → 200.
 * `by` is "tony" — the web board is Tony's surface (mirrors the sibling routes).
 * Behind auth via PROTECTED POST "/tasks/…" (loopback UI bypasses; LAN must auth).
 *
 * Body: { company, id, confirm? } → { ok:true, task } | 409 needsConfirm | error.
 */
export async function handleTaskDoneRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown; confirm?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown; confirm?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const confirm = body.confirm === true;
  if (!company || !id) {
    return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  }
  const existing = readTask(company, id);
  if (!existing) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  // kobo-225: a PR-linked card closes on merge (pr-watch reconcile, kobo-228) — a
  // manual web done would let the UI lie / double-fire. The done-split rule (Board
  // Truth 3/12) says done comes from the PR for a PR-card. Reject at the backend so
  // the guard holds even if the UI button is bypassed; the UI also disables it.
  if (typeof existing.pr === "number") {
    return Response.json(
      { ok: false, prLinked: true, error: `card ${id} is linked to PR #${existing.pr} — it closes on merge (pr-watch), not a manual done` },
      { status: 409 },
    );
  }
  // Guard b (kobo-45): an epic whose children aren't all done needs an explicit
  // confirm before we collapse its scope. Derived at read from the store helpers.
  const open = openEpicChildren(id, listTasks(company));
  if (open.length && !confirm) {
    const rollup = epicRollup(id, listTasks(company)); // {done,total} — present since it has children
    return Response.json(
      { ok: false, needsConfirm: true, rollup, openChildren: open.map((c) => c.id),
        error: `epic has ${open.length} child card(s) not done` },
      { status: 409 },
    );
  }
  const task = completeTask(company, id, "tony");
  if (!task) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  return Response.json({ ok: true, task: { id: task.id, title: task.title, state: task.state } });
}

/**
 * POST /api/tasks/deployed — the wait-for-deploy "🚀 Mark deployed" action (kobo-275).
 * Manual deploy-drain: flip a card parked in wait-for-deploy → done once the merged
 * feature is actually live. Guarded in the store (markDeployedTask) so the backend
 * refuses any card NOT in wait-for-deploy (409) even if the button is bypassed — it can
 * never done a card that never waited. Deploy stays manual (auto-detect rejected,
 * kobo-233). `by` is "tony" — the web board is Tony's surface (mirrors sibling routes).
 * Body: { company, id } → { ok, task } | { ok:false, error }.
 */
export async function handleTaskDeployedRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!company || !id) {
    return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  }
  const res = markDeployedTask(company, id, "tony");
  if (!res.ok) {
    if (res.reason === "not_found") {
      return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
    }
    return Response.json(
      { ok: false, notWaiting: true, state: res.state,
        error: `card ${id} is not in wait-for-deploy (state: ${res.state}) — mark-deployed drains only that lane` },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, task: { id: res.task.id, title: res.task.title, state: res.task.state } });
}

/**
 * POST /api/tasks/approve — the card-detail Approve action (kobo-190 button →
 * kobo-192 execution-card). Derives entirely from the card's `pr` field (Q1=D lock,
 * no new flag):
 *   - HAS pr → merge-single: mark-only. Record a "✅ Tony approved" comment; pr-watch
 *     flips the card to done on merge. NO execution card is spawned.
 *   - NO pr (deploy / no-PR work) → spawn an execution-card ("deploy <title>",
 *     assignee = the work-card's doer, state = in-progress) linked by epic = work-card.
 *     epic (containment) is used ON PURPOSE, not parentIds: parentIds would derive a
 *     dependency block (the work-card isn't done) and strand the execution off-flow in
 *     the Blocked lane instead of in-progress (kobo-192 finding).
 *
 * relate-back (kobo-192): when that execution-card is later completed, the EXISTING
 * epic notify (completeTask → notifyParentOfSubcardDone, kobo-135) pokes the work-card
 * owner to close it. This is a NOTIFY, never an auto-flip — respecting the store scar
 * "auto-flip lies" (store.ts:597, the pr-watch lesson). Tony/the doer closes the
 * work-card manually. So there is deliberately NO completeTask change here.
 *
 * `by` is "tony" — the web board is Tony's surface (mirrors the sibling routes).
 * Behind auth via PROTECTED POST "/tasks/…" (loopback UI bypasses; LAN must auth).
 *
 * Body: { company, id } → { ok, mode:'mark'|'spawn', task? } | { ok:false, error }.
 */
export async function handleTaskApproveRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!company || !id) {
    return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  }
  const work = readTask(company, id);
  if (!work) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  // HAS pr → merge-single mark-only (pr-watch drives it to done); no spawn.
  if (work.pr) {
    commentTask(company, id, "tony", "✅ Tony approved");
    return Response.json({ ok: true, mode: "mark" });
  }
  // NO pr → spawn the execution-card as a containment child (epic) of the work-card.
  const exec = addTask({
    company,
    title: `deploy ${work.title}`,
    by: "tony",
    assignee: work.assignee,
    state: "in-progress",
    epic: work.id,
  });
  return Response.json({
    ok: true,
    mode: "spawn",
    task: { id: exec.id, title: exec.title, state: exec.state, epic: exec.epic ?? null, assignee: exec.assignee ?? null },
  });
}

/**
 * POST /api/tasks/reject — the card-detail Reject action (kobo-225). Moves the card
 * to the Rejected lane ("done but NOT accepted", kobo-101) via the SAME store verb
 * the CLI uses — `reason` MANDATORY (why it wasn't accepted, kept to learn). Reuses
 * the store guard: a done/rejected card is terminal → 409 (no resurrection).
 * Body: { company, id, reason } → { ok:true, task } | 400 | 404 | 409.
 */
export async function handleTaskRejectRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown; reason?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!company || !id) return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  if (!reason) return Response.json({ ok: false, error: "reason is required (why the card was not accepted)" }, { status: 400 });
  const existing = readTask(company, id);
  if (!existing) return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  const task = rejectTask(company, id, "tony", reason);
  if (!task) {
    // rejectTask null on a terminal card (done/rejected) — disambiguate from not-found.
    return Response.json({ ok: false, error: `cannot reject ${id}: already ${existing.state} (terminal)` }, { status: 409 });
  }
  return Response.json({ ok: true, task: { id: task.id, title: task.title, state: task.state } });
}

/**
 * POST /api/tasks/assign — the card-detail Edit-assignee action (kobo-225). Reassign
 * is FRICTION (kobo-219): displacing an existing owner throws ReassignFrictionError,
 * which we surface as 409 { needsForce:true } so the UI asks "reassign = correction,
 * not handoff — confirm?" before re-posting with force:true. First-assign / idempotent
 * need no force. Body: { company, id, to, force? } → { ok:true, task } | 400 | 404 | 409.
 */
export async function handleTaskAssignRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown; to?: unknown; force?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown; to?: unknown; force?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const force = body.force === true;
  if (!company || !id || !to) return Response.json({ ok: false, error: "company, id and to are required" }, { status: 400 });
  if (!readTask(company, id)) return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  try {
    const task = assignTask(company, id, to, "tony", { force });
    if (!task) return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
    return Response.json({ ok: true, task: { id: task.id, title: task.title, assignee: task.assignee ?? null } });
  } catch (e) {
    if (e instanceof ReassignFrictionError) {
      return Response.json(
        { ok: false, needsForce: true, from: e.from, to: e.to, error: e.message },
        { status: 409 },
      );
    }
    throw e;
  }
}

/**
 * POST /api/tasks/edit — the card-detail Edit-reviewer action (kobo-225), wired to
 * the SAME edit verb the CLI uses (kobo-214). A pure in-place content update (same
 * id, lineage untouched); the old value is preserved in an append-only audit note.
 * Does NOT touch hash/idempotency (card id is a counter, never hashed). Scoped to
 * `reviewer` here (the requested button). Body: { company, id, reviewer } → { ok:true, task }.
 */
export async function handleTaskEditRequest(request: Request): Promise<Response> {
  let body: { company?: unknown; id?: unknown; reviewer?: unknown };
  try {
    body = (await request.json()) as { company?: unknown; id?: unknown; reviewer?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!company || !id) return Response.json({ ok: false, error: "company and id are required" }, { status: 400 });
  if (typeof body.reviewer !== "string") return Response.json({ ok: false, error: "reviewer is required" }, { status: 400 });
  const existing = readTask(company, id);
  if (!existing) return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  // kobo-328: refuse setting the executor as reviewer from the board too. NOT full
  // UI↔CLI parity as of kobo-587 — the CLI gained a pane-aware `--to-pane` path
  // (isSelfReviewPaneAware) that can accept a same-oracle reviewer on a distinct pane;
  // a browser edit isn't a tmux pane, so the web path deliberately stays on the plain
  // oracle-name-only isSelfReview below — stricter than the CLI, not equal to it.
  const wantReviewer = body.reviewer.trim();
  if (isSelfReview(existing, wantReviewer)) {
    return Response.json({ ok: false, error: `${wantReviewer} is the assignee/executor of ${id} — self-review banned (executor≠reviewer, kobo-328)` }, { status: 409 });
  }
  const task = editTask(company, id, "tony", { reviewer: wantReviewer });
  if (!task) return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  return Response.json({ ok: true, task: { id: task.id, title: task.title, reviewer: task.reviewer ?? null } });
}

/**
 * GET /api/tasks/events?company=<c>&card=<id> — SSE stream (kobo-207). Pushes an
 * `event: change` whenever the open card's activity-relevant content (state /
 * body / notes / comments / block) changes, so the detail modal hot-reloads live
 * instead of waiting on the 5s board poll.
 *
 * ponytail: server-side polls the store + diffs a serialized snapshot, rather
 * than an in-memory event bus fed by the write routes. Reason (not laziness): a
 * comment/note from ANOTHER process (a `maw task comment` in a peer pane) writes
 * the card file directly and never touches this server's memory — an emitter
 * would silently miss exactly the cross-actor updates this feature exists for.
 * A file-backed store makes a 2s re-read the honest change signal.
 */
export function handleTaskEventsRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = (url.searchParams.get("company") || "").trim();
  const id = (url.searchParams.get("card") || "").trim();
  if (!company || !id) {
    return new Response("company and card are required", { status: 400 });
  }
  // Only the fields the modal renders — a change here is a change worth pushing.
  const snapshot = (): string => {
    const t = readTask(company, id);
    if (!t) return " gone"; // deleted/unknown → still a distinct, stable snapshot
    return JSON.stringify({ s: t.state, b: t.body, bl: t.block, n: t.notes, c: t.comments });
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = "";
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* connection closed mid-write */
        }
      };
      write(": connected\n\n");
      last = snapshot();
      timer = setInterval(() => {
        const cur = snapshot();
        if (cur !== last) {
          last = cur;
          write("event: change\ndata: {}\n\n");
        } else {
          write(": ping\n\n"); // heartbeat — keeps idle intermediaries from dropping the conn
        }
      }, TASK_EVENTS_POLL_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// 2s store re-read is the change signal; env override lets tests poll fast.
const TASK_EVENTS_POLL_MS = Number(process.env.MAW_TASK_EVENTS_POLL_MS) || 2000;
