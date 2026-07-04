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

import { addTask, archiveTask, checklistProgress, completeTask, dependencyBlock, epicRollup, EpicArchiveBlockedError, familyNotes, isStaleDecisionCard, lastActivityByOracle, listTasks, needsOwner, noteTask, openEpicChildren, parentStateResolver, readTask, setTaskEpic, taskNextAction, type ChecklistProgress, type DependencyBlock, type FamilyNote, type ParentState, type TaskKind, type TaskRecord } from "./store";
import { notifyTaskComment } from "./notify";

export interface TaskCard {
  id: string;
  title: string;
  dept: string | null;
  epic: string | null;
  state: TaskRecord["state"];
  assignee: string | null;
  repo?: string;
  pr?: number;
  block?: TaskRecord["block"]; // off-flow block {kind,reason,for} (ADR 0003 B)
  reviewer?: string;
  by: string;
  ts: number;
  updatedTs?: number;
  nextAction: string; // "what next + who" — computed, always present (Track 4)
  checklist?: ChecklistProgress; // derived N/M from body markdown (ADR 0003 C); absent when none
  dependency?: DependencyBlock; // derived blocked-by-dependency (ADR 0003 A) — present only when blockedBy/missing non-empty. NOTE: derived, NOT state==="blocked"
  body?: string; // raw markdown body (ADR 0003 C) — passthrough for the detail view (eq3-010 kobo-11)
  notes?: TaskRecord["notes"]; // append-only notes (kobo-39) — passthrough for the detail-panel timeline
  needsOwner?: true; // derived (eq3-011 kobo-14): todo + unassigned → off-flow "needs an owner". Absent otherwise.
  kind?: TaskRecord["kind"]; // "epic" for a container card (kobo-45) — absent for a normal task
  familyNotes?: FamilyNote[]; // derived (kobo-46): descendant notes tagged by source, for the epic's parent modal. Epics only, when non-empty.
  stale?: true; // derived (mawjs-5): in-progress + no-PR + owner worklog silent → "⏳ stuck? ball on?" soft badge. Visual only, never a state.
}

function toCard(t: TaskRecord, resolveParent: (id: string) => ParentState, cards: TaskRecord[], stale = false): TaskCard {
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
  if (t.block) card.block = t.block;
  if (t.reviewer) card.reviewer = t.reviewer;
  if (t.updatedTs) card.updatedTs = t.updatedTs;
  const progress = checklistProgress(t.body);
  if (progress) card.checklist = progress;
  if (t.body) card.body = t.body; // raw body for the detail panel (read-only)
  if (t.notes?.length) card.notes = t.notes; // append-only notes for the detail-panel timeline (kobo-39)
  if (needsOwner(t)) card.needsOwner = true; // derived needs-owner block (eq3-011 kobo-14)
  // Derived dependency block (ADR 0003 A) — reuse the SAME store helper the CLI
  // board uses, so web + CLI never disagree. Emitted only when there's something
  // to show; the card's real state stays todo/in-progress (this is NOT a block state).
  const dep = dependencyBlock(t, resolveParent);
  if (dep.blockedBy.length || dep.missing.length) card.dependency = dep;
  if (t.kind) card.kind = t.kind; // "epic" (kobo-45) — task default is left absent
  // Epic parent modal (kobo-46 §Comment): descendant notes tagged by source,
  // ready for c3 to merge with the card's own `notes`. Only when there are any.
  if (t.kind === "epic") {
    const fam = familyNotes(t.id, cards);
    if (fam.length) card.familyNotes = fam;
  }
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
  notifyTaskComment(task, by, text); // comment = poke assignee (non-author only, task-events → coord pane)
  return Response.json({ ok: true, id: task.id, notes: task.notes });
}

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
  if (!readTask(company, id)) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
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
