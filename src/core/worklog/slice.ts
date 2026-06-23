/**
 * Inject slice — the small, token-bounded view the engine pushes back into an
 * agent before it acts (UserPromptSubmit) and when it wakes (SessionStart).
 *
 * Read-before-act, automatically: open claims (so you don't double-work) + the
 * most recent significant events in the company log (so you're not stale).
 * Kept deliberately small to avoid token bloat.
 */

import { readWorklog, openClaims } from "./store";
import { companyOfOracle } from "./company-scope";
import { renderLines } from "./render";

const DEFAULT_EVENTS = 12;

export interface SliceOpts {
  events?: number; // recent events to include
}

/** Build the inject text for an oracle (resolves its company). Empty string if nothing. */
export function buildInjectSlice(oracle: string, opts: SliceOpts = {}): string {
  const company = companyOfOracle(oracle);
  const claims = openClaims(company);
  const recent = readWorklog(company, { limit: opts.events ?? DEFAULT_EVENTS });

  if (!claims.length && !recent.length) return "";

  const parts: string[] = ["📋 maw watch — company activity (auto-injected, read before acting):"];
  if (claims.length) {
    parts.push("", "open claims (someone is already on these):");
    for (const c of claims) parts.push(`  ⛏ ${c.oracle}: ${c.task ?? c.summary}`);
  }
  if (recent.length) {
    parts.push("", "recent activity:");
    for (const l of renderLines(recent)) parts.push(`  ${l}`);
  }
  return parts.join("\n");
}
