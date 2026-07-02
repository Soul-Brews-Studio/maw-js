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

import { archiveTask, checklistProgress, dependencyBlock, familyNotes, listTasks, needsOwner, noteTask, parentStateResolver, taskNextAction, type ChecklistProgress, type DependencyBlock, type FamilyNote, type ParentState, type TaskRecord } from "./store";
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
}

function toCard(t: TaskRecord, resolveParent: (id: string) => ParentState, cards: TaskRecord[]): TaskCard {
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
  return card;
}

export function handleTasksRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, tasks: [] });
  const resolveParent = parentStateResolver(company); // active state | "archived" | null — shared across the board
  const cards = listTasks(company);
  return Response.json({ company, tasks: cards.map((t) => toCard(t, resolveParent, cards)) });
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
  const archived = archiveTask(company, id, "web");
  if (!archived) {
    return Response.json({ ok: false, error: `task not found: ${id}` }, { status: 404 });
  }
  return Response.json({ ok: true, id: archived.id, title: archived.title });
}
