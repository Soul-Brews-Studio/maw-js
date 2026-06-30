/**
 * Company state-doc read route (Web Request → Response), registered by the watch
 * plugin's serve hook (ctx.http.route). Behind auth via the "/state" entry in
 * elysia-auth PROTECTED (loopback UI bypasses; LAN must auth) — coordination
 * state is company-internal (Rule 6), same surface as /api/worklog.
 *
 *   GET /api/state?company=<name> → { company, exists, markdown }
 *
 * Reads `<mawData>/companies/<company>/state.md` (≈ ~/.maw/companies/<company>/
 * state.md in the default layout) — the Company Home (ADR 0001 §6), beside
 * policy/ and tasks/. Read-only: the file is owned by the company, this just
 * surfaces it. Returns raw markdown — the company-ui panel renders md→HTML so the
 * endpoint stays a dumb, generic file-read (panel type = markdown-file). Missing
 * file → { exists:false, markdown:"" } (panel hides; never an error). See spec §6
 * addendum.
 */

import { existsSync, readFileSync } from "fs";
import { mawDataPath } from "../xdg";

/** company → safe single path segment (no traversal, no separators, no dots). */
function safeSegment(company: string): string {
  return company.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function stateDocPath(company: string): string {
  return mawDataPath("companies", safeSegment(company), "state.md");
}

export function handleStateDocRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, exists: false, markdown: "" });
  const p = stateDocPath(company);
  if (!existsSync(p)) return Response.json({ company, exists: false, markdown: "" });
  let markdown = "";
  try {
    markdown = readFileSync(p, "utf-8");
  } catch {
    return Response.json({ company, exists: false, markdown: "" });
  }
  return Response.json({ company, exists: true, markdown });
}
