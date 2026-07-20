/**
 * Presence "away" read side (mawjs-3 / kobo-113; sticky kobo-287).
 *
 * An oracle/pane is "away" when its newest `away`/`back` marker is an `away`
 * (written by `maw presence away`, typically from /toilet). STICKY: ordinary
 * tool/prompt activity does NOT clear it — only an explicit `maw presence back`
 * (from /seat) does. Rationale (kobo-287): /toilet sets away at step-0 then does
 * its OWN rrr/forward tool-writes; under the old newest-wins-any-activity rule
 * those self-writes cleared away ~5s in, re-opening the overtype window mid-wrap
 * and at /clear — so "parks until /seat" was FALSE. Away is an explicit operator
 * toggle; it ends when the operator explicitly returns, not on background writes.
 * Tradeoff: a pane that forgot to /seat stays "away" until it does (seat-resume.sh
 * emits `back` on /seat, so the normal path self-heals). No new store.
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
      // kobo-363 dual-read: `teams` preferred, `departments` = legacy fallback
      // (this reader bypasses loadCompany's normalization on purpose — barrel-free
      // twin — so it needs its own dual-read, same as loadCompany's).
      for (const dept of Object.values(c?.teams ?? c?.departments ?? {})) {
        const members = (dept as { members?: Array<{ oracle?: string }> })?.members ?? [];
        if (members.some((m) => m?.oracle === oracle)) return c.name ?? f.replace(/\.json$/, "");
      }
    } catch {
      // half-written / unexpected shape → skip, never fault the delivery path
    }
  }
  return null;
}

// Under sticky-away (kobo-287) EVERY kind except `away`/`back` is transparent, so the
// read below already ignores idle/error. Keep excluding them at the store read anyway:
// it trims the two highest-volume kinds (every turn-end) from the scan for free.
const AWAY_TRANSPARENT: WorklogEntry["kind"][] = ["idle", "error"];

/**
 * True iff the given PANE's newest `away`/`back` marker is `away` (kobo-120; sticky kobo-287).
 *
 * Per-pane: one oracle can own several panes (crew/warroom = coord + workers, same
 * oracle name). `away` is a property of the pane the operator stepped out of, not the
 * whole oracle — so the marker is scoped to `paneId` (the tmux `%N` id the worklog
 * stamps, same JOIN key on every event). STICKY: only a deliberate `back` (from /seat)
 * clears it; ordinary activity (tool/conversation/…) is transparent, so the pane's own
 * /toilet wrap-writes can't re-open the gate mid-wrap (kobo-287).
 *
 * paneId unknown (non-tmux / unresolvable) → falls back to oracle-level: the newest
 * away/back marker across all the oracle's panes. Cheap: one bounded read.
 */
export function isPaneAway(oracle: string | null | undefined, paneId: string | null | undefined): boolean {
  const name = (oracle ?? "").trim();
  if (!name) return false;
  const pid = (paneId ?? "").trim();
  const company = companyOfOracleLight(name);
  const events = readWorklog(company, { oracle: name, excludeKinds: AWAY_TRANSPARENT });
  // Newest-first: the first away/back marker belonging to this pane decides; all other
  // activity is skipped (sticky). When paneId is known, markers from OTHER panes of the
  // same oracle are skipped (a marker with no paneId is pane-agnostic → it still decides,
  // preserving the oracle-level fallback).
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (pid && e.paneId && e.paneId !== pid) continue;
    if (e.kind === "away") return true;
    if (e.kind === "back") return false;
  }
  return false;
}
