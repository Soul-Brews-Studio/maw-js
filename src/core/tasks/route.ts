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
 * lifecycle + needs-attention/attention). wait-for is NOT returned — the board
 * derives it (by≠assignee · state≠done). Read-only.
 */

import { checklistProgress, listTasks, taskNextAction, type ChecklistProgress, type TaskRecord } from "./store";

export interface TaskCard {
  id: string;
  title: string;
  dept: string | null;
  epic: string | null;
  state: TaskRecord["state"];
  assignee: string | null;
  repo?: string;
  pr?: number;
  attention?: TaskRecord["attention"];
  reviewer?: string;
  by: string;
  ts: number;
  updatedTs?: number;
  nextAction: string; // "what next + who" — computed, always present (Track 4)
  checklist?: ChecklistProgress; // derived N/M from body markdown (ADR 0003 C); absent when none
}

function toCard(t: TaskRecord): TaskCard {
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
  if (t.attention) card.attention = t.attention;
  if (t.reviewer) card.reviewer = t.reviewer;
  if (t.updatedTs) card.updatedTs = t.updatedTs;
  const progress = checklistProgress(t.body);
  if (progress) card.checklist = progress;
  return card;
}

export function handleTasksRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, tasks: [] });
  return Response.json({ company, tasks: listTasks(company).map(toCard) });
}
