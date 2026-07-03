/**
 * Company roster read route (kobo-50, item 3) — registered by the watch plugin's
 * serve hook. Behind auth via the "/roster" entry in elysia-auth PROTECTED
 * (loopback UI bypasses; LAN must auth) — company membership is company-internal
 * (Rule 6), same surface as /api/tasks + /api/state.
 *
 *   GET /api/roster?company=<name> → { company, roster: [ { oracle, dept, role } ] }
 *
 * Source is the company REGISTRY (companyRoster → loadCompany), NOT `maw ls`:
 * `maw ls` is fleet/tmux-wide live sessions, this is the authoritative per-company
 * org membership. The web Presence tab uses it so oracles with no recent worklog
 * activity still appear (the c5 gap), overlaying worklog-derived status on top.
 * Read-only. Unknown/absent company → empty roster (never an error).
 */

import { companyRoster } from "../worklog/company-scope";

export function handleRosterRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, roster: [] });
  return Response.json({ company, roster: companyRoster(company) });
}
