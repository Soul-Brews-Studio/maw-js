/**
 * Presence "away" read side (mawjs-3 / kobo-113).
 *
 * An oracle is "away" when its NEWEST worklog event is a kind:"away" (written by
 * `maw presence away`, typically from /toilet). newest-wins: any later event —
 * `maw presence back` → idle, or ordinary tool/prompt activity — clears it. This
 * mirrors the kobo-109/111 idle/error pane-state pattern; no new store.
 *
 * Used by the hey delivery gate (comm-send) to PARK a message to the receiver
 * inbox instead of injecting a pane whose operator has stepped out (and may be
 * mid-/clear — injecting would overtype). Delivery happens when they /seat.
 *
 * Company resolution is inlined as a light fs scan on purpose: importing
 * company-scope pulls company-helpers → the `maw-js/sdk` barrel, which a
 * cache-busting isolated re-import of the fragile comm-send delivery path can't
 * initialize cleanly. The company registry schema is stable, so a direct read
 * keeps the hot path barrel-free (mirrors companyOfOracle's membership lookup).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { mawDataPath } from "../xdg";
import { readWorklog } from "./store";
import type { WorklogEntry } from "./types";

/** Which company an oracle belongs to (manager or any dept member), or null.
 *  Barrel-free twin of companyOfOracle — used by BOTH the `maw presence` writer
 *  and this reader so the away event lands in, and is read from, the same log. */
export function companyOfOracleLight(oracle: string): string | null {
  const dir = mawDataPath("companies");
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    // kobo-216 — SORT so this first-match agrees with companyOfOracle's (which iterates
    // the name-sorted listCompanies). A company file is `<name>.json`, so sorting the
    // filenames = sorting by company name; both twins now pick the same first company
    // for a multi-company oracle instead of diverging on raw readdir order.
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (c?.manager === oracle) return c.name ?? f.replace(/\.json$/, "");
      for (const dept of Object.values(c?.departments ?? {})) {
        const members = (dept as { members?: Array<{ oracle?: string }> })?.members ?? [];
        if (members.some((m) => m?.oracle === oracle)) return c.name ?? f.replace(/\.json$/, "");
      }
    } catch {
      // half-written / unexpected shape → skip, never fault the delivery path
    }
  }
  return null;
}

// idle (CC Stop, kobo-109) and error (API-error turn-end, kobo-111) are TRANSPARENT to
// presence: a pane whose operator stepped out will emit an idle right after (the turn
// ended) — that must NOT clear the away, or the gate re-opens the moment they leave.
// Neither reflects the operator returning, so both are skipped when deciding away.
const AWAY_TRANSPARENT: WorklogEntry["kind"][] = ["idle", "error"];

/**
 * True iff the given PANE's newest presence-relevant event is `away` (kobo-120).
 *
 * Per-pane: one oracle can own several panes (crew/warroom = coord + workers, same
 * oracle name). `away` is a property of the pane the operator stepped out of, not the
 * whole oracle — so the newest event is scoped to `paneId` (the tmux `%N` id the worklog
 * stamps, same JOIN key on every event). A deliberate `back` OR any real activity
 * (tool/conversation/…) on that pane is newer-wins and clears it; only idle/error are
 * skipped (see AWAY_TRANSPARENT).
 *
 * paneId unknown (non-tmux / unresolvable) → falls back to oracle-level: the newest
 * non-transparent event across all the oracle's panes. Cheap: one bounded read.
 */
export function isPaneAway(oracle: string | null | undefined, paneId: string | null | undefined): boolean {
  const name = (oracle ?? "").trim();
  if (!name) return false;
  const pid = (paneId ?? "").trim();
  const company = companyOfOracleLight(name);
  const events = readWorklog(company, { oracle: name, excludeKinds: AWAY_TRANSPARENT });
  // Newest-first: the first event belonging to this pane decides. When paneId is known,
  // events from OTHER panes of the same oracle are skipped (an event with no paneId is
  // pane-agnostic → it still decides, preserving the oracle-level fallback).
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (pid && e.paneId && e.paneId !== pid) continue;
    return e.kind === "away";
  }
  return false;
}
