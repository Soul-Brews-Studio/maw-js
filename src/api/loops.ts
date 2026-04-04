/**
 * Loops API — HTTP endpoints for scheduled loop management.
 *
 * GET  /loops              List all loops + state
 * POST /loops/trigger      Trigger a loop by id { id: "..." }
 */

import { Hono } from "hono";
import { getLoops, getLoopStates, triggerLoop, nextCronTime } from "../loops";

export const loopsApi = new Hono();

loopsApi.get("/loops", (c) => {
  const loops = getLoops();
  const states = getLoopStates();

  const items = loops.map(loop => {
    const state = states.get(loop.id);
    let nextRun: number | null = null;
    try { nextRun = state?.nextRun || nextCronTime(loop.schedule).getTime(); } catch { /* ignore */ }

    return {
      ...loop,
      lastRun: state?.lastRun || null,
      lastOk: state?.lastOk ?? null,
      nextRun,
      runCount: state?.runCount || 0,
      errors: state?.errors || 0,
    };
  });

  return c.json({ loops: items, total: items.length });
});

loopsApi.post("/loops/trigger", async (c) => {
  const body = await c.req.json();
  const id = body.id as string;

  if (!id) return c.json({ error: "Missing loop id" }, 400);

  const ok = await triggerLoop(id);
  if (!ok) return c.json({ error: `Loop not found: ${id}` }, 404);

  return c.json({ ok: true, id, triggered: Date.now() });
});
