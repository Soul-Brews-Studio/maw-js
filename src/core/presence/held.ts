/**
 * Held-work cross-reference (kobo-105) — the structured "this oracle is holding
 * work" signal behind the Presence tab's idle-with-work (⚠️) state.
 *
 * The plain idle badge (no worklog activity for ACTIVE_MS) can lie: a deadlocked
 * or wedged agent stops emitting worklog events, so it LOOKS idle while it is
 * actually stuck on work. To surface that, we cross-reference two structured
 * ownership signals (NOT status-text regex, which is weak):
 *   1. open worklog claims — `openClaims(company)` (the ⛏ registry)
 *   2. in-progress task cards — `listTasks(company)` where state=in-progress,
 *      folded onto the card's assignee (SSoT for ownership).
 *
 * Per ORACLE, not per pane: a claim/card belongs to an oracle and maw has no
 * idea which pane holds it. The Presence tab shows the warning on the oracle
 * card header; per-pane model/context sub-rows (kobo-104) are unchanged.
 */

import { openClaims } from "../worklog/store";
import { isTerminalState, listTasks } from "../tasks/store";
import type { TaskRecord, TaskState } from "../tasks/store";

export interface HeldWork {
  id: string;
  kind: "claim" | "card";
  title?: string;
}

export interface PendingWork {
  id: string;
  title: string;
  state: TaskState;
  updatedTs: number;
}

/** { oracle → held work }. An oracle with no open claim / in-progress card is
 *  simply absent from the map (→ a truly-idle oracle stays grey). A card and a
 *  claim for the same id fold to one entry (card wins — it carries the title).
 *
 *  `tasks` (kobo-445 review round 2): optional pre-fetched listTasks(company)
 *  result. /api/roster calls BOTH this and pendingTasksByOracle per request —
 *  without this param each one called listTasks itself, so one /api/roster
 *  request opened+parsed every task file TWICE (532 files, not once, despite
 *  the roster route's own comment claiming a single shared scan — caught in
 *  review, the comment was aspirational, not what the code did). Callers with
 *  no tasks list yet (tests, any other future caller) still work — falls back
 *  to fetching it here. */
export function heldWorkByOracle(company: string | null | undefined, tasks?: TaskRecord[]): Record<string, HeldWork[]> {
  const out: Record<string, HeldWork[]> = {};
  const push = (oracle: string | null | undefined, id: string | undefined | null, kind: "claim" | "card", title?: string) => {
    if (!oracle || !id) return;
    let arr = out[oracle];
    if (!arr) { arr = []; out[oracle] = arr; }
    if (!arr.some((h) => h.id === id)) arr.push(title ? { id, kind, title } : { id, kind });
  };
  // in-progress cards first so a card+claim collision keeps the card (with title).
  if (company) {
    for (const t of tasks ?? listTasks(company)) {
      if (t.state === "in-progress" && t.assignee) push(t.assignee, t.id, "card", t.title);
    }
  }
  for (const c of openClaims(company)) {
    push(c.oracle, c.task ?? c.summary, "claim");
  }
  return out;
}

/**
 * { oracle → every non-terminal card assigned to them }, sorted newest-first
 * per oracle (kobo-445 rev — company-status page's "ของค้าง" panel needs the
 * FULL pending set, not just in-progress/claims: a card sitting in todo,
 * review, blocked, need-answer, approve, or wait-for-deploy is still pending
 * work, just not the "possible deadlock" signal heldWorkByOracle targets).
 * done/rejected are excluded via the same isTerminalState the board itself
 * uses — a card leaving the board (closing) drops out of this list on the
 * next call, no separate close-tracking needed.
 *
 * `tasks` — see heldWorkByOracle's doc: same optional pre-fetched-list param,
 * same reason (one /api/roster request must scan the task directory once).
 */
export function pendingTasksByOracle(company: string | null | undefined, tasks?: TaskRecord[]): Record<string, PendingWork[]> {
  const out: Record<string, PendingWork[]> = {};
  if (!company) return out;
  for (const t of tasks ?? listTasks(company)) {
    if (!t.assignee || isTerminalState(t.state)) continue;
    const updatedTs = t.updatedTs ?? t.ts;
    let arr = out[t.assignee];
    if (!arr) { arr = []; out[t.assignee] = arr; }
    arr.push({ id: t.id, title: t.title, state: t.state, updatedTs });
  }
  for (const arr of Object.values(out)) arr.sort((a, b) => b.updatedTs - a.updatedTs);
  return out;
}
