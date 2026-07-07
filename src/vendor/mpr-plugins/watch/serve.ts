/**
 * watch plugin — serve lifecycle hook. THIS is what makes the engine toggleable:
 * disabling the `watch` plugin means this hook never runs, so neither the capture
 * listener nor the /api/worklog route is registered → capture + inject are off.
 *
 * - capture: add the feed listener (PostToolUse/UserPromptSubmit/interrupt → worklog)
 * - inject/read: register GET /api/worklog (behind auth — see PROTECTED "/worklog")
 * - company-ui (read-only): GET /api/worklog/feed (timeline) + GET /api/tasks
 *   (board) + GET /api/state (coordination markdown panel) — toggle with this
 *   plugin, same worklog-engine territory (spec §6 + addendum).
 */

import type { PluginLifecycleContext } from "maw-js/plugin/lifecycle";
import { registerWorklogListener } from "../../../core/worklog/listener";
import { handleWorklogRequest, handleWorklogFeedRequest } from "../../../core/worklog/route";
import { handleTasksRequest, handleTaskArchiveRequest, handleTaskNoteRequest, handleTaskCommentRequest, handleTaskResolveRequest, handleTaskCreateRequest, handleTaskDoneRequest, handleTaskApproveRequest } from "../../../core/tasks/route";
import { handleStateDocRequest } from "../../../core/state-doc/route";
import { handleRosterRequest } from "../../../core/roster/route";
import { handlePresenceRequest } from "../../../core/presence/route";
import { handlePolicyRequest } from "../../../core/policy/route";
import { companyVersion } from "../../../views/company";
import { feedListeners } from "../../../api/feed";

export function serve(ctx: PluginLifecycleContext): { ok: true } {
  // capture (idempotent across reloads)
  registerWorklogListener(feedListeners);
  // read/inject route
  ctx.http?.route("GET", "/api/worklog", (request: Request) => handleWorklogRequest(request));
  // company-ui timeline feed (behind auth — see PROTECTED "/worklog/feed")
  ctx.http?.route("GET", "/api/worklog/feed", (request: Request) => handleWorklogFeedRequest(request));
  // company-ui kanban board — stub now, backbone later (behind auth — PROTECTED "/tasks")
  ctx.http?.route("GET", "/api/tasks", (request: Request) => handleTasksRequest(request));
  // company-ui per-card archive (kobo-35): Tony reviews a done card + clicks
  // archive → moves it off the board (behind auth — PROTECTED POST "/tasks/…").
  ctx.http?.route("POST", "/api/tasks/archive", (request: Request) => handleTaskArchiveRequest(request));
  // company-ui card comment (kobo-46): Tony posts a note from the modal → append
  // + poke assignee on task-events (behind auth — PROTECTED POST "/tasks/…").
  ctx.http?.route("POST", "/api/tasks/note", (request: Request) => handleTaskNoteRequest(request));
  // company-ui threaded comment (kobo-141): the modal's comment thread posts an
  // ask/answer comment (replyTo threads it) → poke assignee on task-events. Distinct
  // from a note (Board Truth rule 10). Behind auth via PROTECTED POST "/tasks/…".
  ctx.http?.route("POST", "/api/tasks/comment", (request: Request) => handleTaskCommentRequest(request));
  // company-ui resolve comment (kobo-141): Tony resolves an ask thread from the
  // modal / mentions bar → drops it out of the mentions queue (behind auth).
  ctx.http?.route("POST", "/api/tasks/resolve", (request: Request) => handleTaskResolveRequest(request));
  // company-ui card create (kobo-48): the modal "+ subtask" button posts a child
  // card (epic = parent id) → c1 containment (behind auth — PROTECTED POST "/tasks/…").
  ctx.http?.route("POST", "/api/tasks/create", (request: Request) => handleTaskCreateRequest(request));
  // company-ui mark-done (kobo-50): the modal "mark done" button posts a card→done
  // transition; an epic w/ incomplete children → 409 needsConfirm (guard b). Behind
  // auth via PROTECTED POST "/tasks/…".
  ctx.http?.route("POST", "/api/tasks/done", (request: Request) => handleTaskDoneRequest(request));
  // company-ui approve (kobo-192): the card-detail Approve button posts a card→approve
  // action; server derives from the pr field — has pr = mark-only comment, no pr =
  // spawn an execution-card (epic=work, in-progress). Behind auth (PROTECTED /tasks/…).
  ctx.http?.route("POST", "/api/tasks/approve", (request: Request) => handleTaskApproveRequest(request));
  // company-ui coordination markdown panel (behind auth — PROTECTED "/state")
  ctx.http?.route("GET", "/api/state", (request: Request) => handleStateDocRequest(request));
  // company-ui presence roster (kobo-50): authoritative company membership for the
  // Presence tab (behind auth — PROTECTED "/roster").
  ctx.http?.route("GET", "/api/roster", (request: Request) => handleRosterRequest(request));
  // company-ui presence detail (kobo-104): per-pane model + context% from the
  // statusLine capture files (behind auth — PROTECTED "/presence").
  ctx.http?.route("GET", "/api/presence", (request: Request) => handlePresenceRequest(request));
  // company/dept policy inject route — on-attach context (separate concern,
  // toggles with this plugin). Behind auth via PROTECTED "/policy".
  ctx.http?.route("GET", "/api/policy", (request: Request) => handlePolicyRequest(request));
  // cache-bust version (kobo-57): the board polls this + compares to the version
  // it loaded with → a "reload" banner after a deploy. Public (just a content
  // hash — no company data), so it works before/without auth.
  ctx.http?.route("GET", "/api/version", () => Response.json({ version: companyVersion() }));
  return { ok: true };
}
