/**
 * Alerts API — manage escalation chain.
 */

import { Hono } from "hono";
import { getEscalation } from "../engine/escalation";

export const alertsApi = new Hono();

/** GET /alerts/active — list unacknowledged alerts */
alertsApi.get("/alerts/active", (c) => {
  return c.json({ alerts: getEscalation().getActive() });
});

/** POST /alerts/acknowledge/:id — acknowledge and stop escalation */
alertsApi.post("/alerts/acknowledge/:id", (c) => {
  const id = c.req.param("id");
  const ok = getEscalation().acknowledge(id);
  return c.json({ ok, alertId: id });
});

/** POST /alerts/test — trigger a test alert through the chain */
alertsApi.post("/alerts/test", (c) => {
  const alertId = `test-${Date.now()}`;
  const metrics = { memUsedPct: 95, diskUsedPct: 88, loadAvg: "4.2 3.1 2.5" };
  getEscalation().escalate(alertId, metrics, "Test alert — this is a drill");
  return c.json({ ok: true, alertId, message: "Test alert triggered" });
});
