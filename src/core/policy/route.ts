/**
 * Policy read route handler (Web Request → Response), registered by the watch
 * plugin's serve hook (ctx.http.route) — NOT mounted in core. Mirrors the
 * worklog inject route: the `company-policy.sh` hook GETs it on UserPromptSubmit
 * and feeds `.inject` back as additionalContext.
 *
 *   GET /api/policy?oracle=<name>  → { inject: "<policy text>" }   ("" if detached)
 */

import { buildPolicyInject } from "./inject";

export function handlePolicyRequest(request: Request): Response {
  const url = new URL(request.url);
  const oracle = url.searchParams.get("oracle");
  return Response.json({ inject: oracle ? buildPolicyInject(oracle) : "" });
}
