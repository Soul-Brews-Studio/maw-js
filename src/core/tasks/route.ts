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

import { checklistProgress, dependencyBlock, listTasks, needsOwner, parentStateResolver, taskNextAction, type ChecklistProgress, type DependencyBlock, type ParentState, type TaskRecord } from "./store";

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
  needsOwner?: true; // derived (eq3-011 kobo-14): todo + unassigned → off-flow "needs an owner". Absent otherwise.
}

function toCard(t: TaskRecord, resolveParent: (id: string) => ParentState): TaskCard {
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
  if (needsOwner(t)) card.needsOwner = true; // derived needs-owner block (eq3-011 kobo-14)
  // Derived dependency block (ADR 0003 A) — reuse the SAME store helper the CLI
  // board uses, so web + CLI never disagree. Emitted only when there's something
  // to show; the card's real state stays todo/in-progress (this is NOT a block state).
  const dep = dependencyBlock(t, resolveParent);
  if (dep.blockedBy.length || dep.missing.length) card.dependency = dep;
  return card;
}

export function handleTasksRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, tasks: [] });
  const resolveParent = parentStateResolver(company); // active state | "archived" | null — shared across the board
  return Response.json({ company, tasks: listTasks(company).map((t) => toCard(t, resolveParent)) });
}
