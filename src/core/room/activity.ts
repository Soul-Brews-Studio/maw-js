/**
 * Room activity projection (kobo-242, slice 3) — CC-style "who's doing what" for a
 * room's participants. Builds NOTHING new: participants come from the `from` fields
 * already on the 241 artifact, "doing X" from the worklog feed, busy/idle+ctx from
 * presence. A pure join over three existing readers (mirrors handleWorklogFeedRequest
 * as a projection), so it's unit-testable without the HTTP layer.
 */

import type { RoomArtifact } from "./store";
import type { WorklogEntry } from "../worklog/types";
import type { PresenceRow } from "../presence/route";

export interface RoomParticipant {
  oracle: string; // bare name as it appears on the thread (host prefix stripped)
  activity: string | null; // latest worklog summary — the "doing X"
  kind: string | null;
  iso: string | null;
  busy: boolean; // a live (non-stale) presence row exists
  stale: boolean;
  model: string | null;
  ctxRemaining: number | null; // remaining context %
}

/** `m5:eq3` / `eq3.0` → `eq3` — worklog + presence key by bare oracle, so join on it. */
export function bareName(s: string): string {
  const noHost = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
  const noPane = noHost.includes(".") ? noHost.slice(0, noHost.indexOf(".")) : noHost;
  return noPane.trim();
}

/**
 * Join a room's distinct participants (excluding the `web` author) with their latest
 * worklog entry + presence row. Order follows first appearance on the thread.
 */
export function roomActivity(
  room: RoomArtifact,
  worklog: WorklogEntry[],
  presence: PresenceRow[],
): RoomParticipant[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const name = bareName(raw || "");
    if (!name || name === "web") return; // the human/web side isn't a teammate
    if (!seen.has(name)) { seen.add(name); order.push(name); }
  };
  // explicitly pulled-in teammates first (kobo-260 invite) — they show in "who's here"
  // before their first turn — then everyone who has spoken (derived from the thread).
  for (const p of room.participants ?? []) add(p);
  for (const m of room.messages) add(m.from || "");

  const wl = new Map<string, WorklogEntry>();
  for (const e of worklog) wl.set(bareName(e.oracle), e); // append-order → last write = newest

  const pr = new Map<string, PresenceRow>();
  for (const p of presence) {
    if (!p.oracle) continue;
    const k = bareName(p.oracle);
    const prev = pr.get(k);
    if (!prev || (!p.stale && prev.stale)) pr.set(k, p); // prefer a live row over a stale one
  }

  return order.map((oracle) => {
    const e = wl.get(oracle) ?? null;
    const p = pr.get(oracle) ?? null;
    return {
      oracle,
      activity: e ? e.summary : null,
      kind: e ? e.kind : null,
      iso: e ? e.iso : null,
      busy: !!p && !p.stale,
      stale: !p || p.stale,
      model: p ? p.model : null,
      ctxRemaining: p ? p.remaining_percentage : null,
    };
  });
}
