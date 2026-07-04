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
import { listTasks } from "../tasks/store";

export interface HeldWork {
  id: string;
  kind: "claim" | "card";
  title?: string;
}

/** { oracle → held work }. An oracle with no open claim / in-progress card is
 *  simply absent from the map (→ a truly-idle oracle stays grey). A card and a
 *  claim for the same id fold to one entry (card wins — it carries the title). */
export function heldWorkByOracle(company: string | null | undefined): Record<string, HeldWork[]> {
  const out: Record<string, HeldWork[]> = {};
  const push = (oracle: string | null | undefined, id: string | undefined | null, kind: "claim" | "card", title?: string) => {
    if (!oracle || !id) return;
    let arr = out[oracle];
    if (!arr) { arr = []; out[oracle] = arr; }
    if (!arr.some((h) => h.id === id)) arr.push(title ? { id, kind, title } : { id, kind });
  };
  // in-progress cards first so a card+claim collision keeps the card (with title).
  if (company) {
    for (const t of listTasks(company)) {
      if (t.state === "in-progress" && t.assignee) push(t.assignee, t.id, "card", t.title);
    }
  }
  for (const c of openClaims(company)) {
    push(c.oracle, c.task ?? c.summary, "claim");
  }
  return out;
}
