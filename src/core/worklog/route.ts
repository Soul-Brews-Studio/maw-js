/**
 * Worklog read route handler (Web Request → Response), registered by the watch
 * plugin's serve hook (ctx.http.route) — NOT mounted in core. Behind auth via the
 * "/worklog" entry in elysia-auth PROTECTED (loopback hooks bypass; LAN must auth)
 * so captured prompts/commands aren't readable cross-company on the LAN.
 *
 *   GET /api/worklog?oracle=<name>          → { inject: "<slice text>" }
 *   GET /api/worklog?company=<name>&limit=N → { entries: [...] }   (debug)
 */

import { buildInjectSlice } from "./slice";
import { readWorklog } from "./store";

export function handleWorklogRequest(request: Request): Response {
  const url = new URL(request.url);
  const oracle = url.searchParams.get("oracle");
  if (oracle) {
    const ev = url.searchParams.get("events");
    const events = ev ? Math.max(1, Math.min(50, +ev || 12)) : undefined;
    return Response.json({ inject: buildInjectSlice(oracle, { events }) });
  }
  const company = url.searchParams.get("company");
  const lim = url.searchParams.get("limit");
  const limit = lim ? Math.max(1, Math.min(500, +lim || 50)) : 50;
  return Response.json({ entries: readWorklog(company, { limit }) });
}
