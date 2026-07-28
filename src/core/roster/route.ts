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
import { heldWorkByOracle, pendingTasksByOracle } from "../presence/held";
import { listTasks } from "../tasks/store";

export function handleRosterRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, roster: [], held: {}, pending: {} });
  // kobo-445 review round 2: listTasks(company) reads+parses every task file in
  // the company (532 in kobo) — fetch it ONCE here and hand the same array to
  // both held/pending functions, so one /api/roster request does one directory
  // scan, not two (heldWorkByOracle and pendingTasksByOracle both used to call
  // listTasks independently — same bug shape as the /api/tasks fetch this page
  // exists to avoid, just one layer down).
  const tasks = listTasks(company);
  // `held` (kobo-105): { oracle → open claims + in-progress cards } so the
  // Presence tab can flag an idle-looking oracle that is actually holding work.
  // `pending` (kobo-445): { oracle → every non-terminal card }, the fuller set the
  // company-status page needs. Gated behind ?pending=1 (kobo-445 review round 2:
  // "does this make the existing /api/roster caller heavier?" — yes, if it always
  // shipped: the Presence tab (company.ts) never reads `pending` and would still
  // pay the extra response bytes on every poll. Computing it is now cheap (shares
  // the one listTasks scan above), but SERIALIZING+TRANSMITTING an unused,
  // potentially-large field to a caller that never asked for it is not — so only
  // build/include it for a caller that opts in).
  const includePending = url.searchParams.get("pending") === "1";
  return Response.json({
    company,
    roster: companyRoster(company),
    held: heldWorkByOracle(company, tasks),
    pending: includePending ? pendingTasksByOracle(company, tasks) : {},
  });
}
