/**
 * Tasks read route handler (Web Request → Response), registered by the watch
 * plugin's serve hook (ctx.http.route) — co-located with the worklog engine
 * because the real backbone (spec §4) grows `maw task` on top of worklog kinds
 * (task-created / task-done). Behind auth via the "/tasks" entry in elysia-auth
 * PROTECTED (loopback UI bypasses; LAN must auth) — same Rule-6 surface as
 * /api/worklog: the board reveals who-works-on-what within a company.
 *
 *   GET /api/tasks?company=<name> → { company, tasks: [ TaskCard, … ] }
 *
 * PHASE 1 = STUB. Returns mock cards so company-ui renders end-to-end while the
 * backbone (`maw task` CLI + hybrid store) is built in a separate request. The
 * locked contract (spec §6) is honoured field-for-field so the real store can
 * be swapped in with zero UI change.
 */

export interface TaskCard {
  id: string;
  title: string;
  dept: string;
  state: "open" | "claimed" | "done";
  assignee: string | null;
  repo?: string;
  pr?: number;
  by: string;
  ts: number;
}

/** Deterministic mock board (3 columns) — replaced by the real store in phase 2. */
function stubTasks(company: string): TaskCard[] {
  return [
    { id: `${company}-1`, title: "stub: open task (backbone pending)", dept: "core", state: "open", assignee: null, by: "lead", ts: 1_751_270_400_000 },
    { id: `${company}-2`, title: "stub: claimed task", dept: "core", state: "claimed", assignee: "worker", repo: "meganechan/maw-js", by: "lead", ts: 1_751_274_000_000 },
    { id: `${company}-3`, title: "stub: done task", dept: "utils", state: "done", assignee: "worker", repo: "meganechan/maw-js", pr: 42, by: "lead", ts: 1_751_277_600_000 },
  ];
}

export function handleTasksRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  if (!company) return Response.json({ company: null, tasks: [] });
  return Response.json({ company, tasks: stubTasks(company) });
}
