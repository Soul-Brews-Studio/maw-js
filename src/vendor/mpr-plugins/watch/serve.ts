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
import { handleTasksRequest } from "../../../core/tasks/route";
import { handleStateDocRequest } from "../../../core/state-doc/route";
import { handlePolicyRequest } from "../../../core/policy/route";
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
  // company-ui coordination markdown panel (behind auth — PROTECTED "/state")
  ctx.http?.route("GET", "/api/state", (request: Request) => handleStateDocRequest(request));
  // company/dept policy inject route — on-attach context (separate concern,
  // toggles with this plugin). Behind auth via PROTECTED "/policy".
  ctx.http?.route("GET", "/api/policy", (request: Request) => handlePolicyRequest(request));
  return { ok: true };
}
