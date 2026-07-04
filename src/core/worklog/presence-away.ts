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

/** Which company an oracle belongs to (manager or any dept member), or null.
 *  Barrel-free twin of companyOfOracle — used by BOTH the `maw presence` writer
 *  and this reader so the away event lands in, and is read from, the same log. */
export function companyOfOracleLight(oracle: string): string | null {
  const dir = mawDataPath("companies");
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
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

/** True iff the oracle's newest worklog event is `away`. Cheap: one bounded read. */
export function isOracleAway(oracle: string | null | undefined): boolean {
  const name = (oracle ?? "").trim();
  if (!name) return false;
  const company = companyOfOracleLight(name);
  // limit:1 after the oracle filter → the single newest event for this oracle.
  const latest = readWorklog(company, { oracle: name, limit: 1 });
  return latest.length > 0 && latest[0].kind === "away";
}
