import { Elysia } from "elysia";
import { getTriggers, getTriggerHistory, fire, type TriggerContext } from "../triggers";
import type { TriggerEvent } from "../config";
import { TriggerFireBody, type TTriggerFireBody } from "../lib/schemas";

export const triggersApi = new Elysia();

/** GET /triggers — list configured triggers + last fired */
triggersApi.get("/triggers", () => {
  const triggers = getTriggers();
  const history = getTriggerHistory();

  const items = triggers.map((t, i) => {
    const last = history.find(h => h.index === i);
    return {
      index: i,
      on: t.on,
      repo: t.repo || null,
      timeout: t.timeout || null,
      action: t.action,
      name: t.name || null,
      lastFired: last ? {
        ts: last.result.ts,
        ok: last.result.ok,
        action: last.result.action,
        error: last.result.error || null,
      } : null,
    };
  });

  return { triggers: items, total: items.length };
});

/** POST /triggers/fire — manually fire a trigger event */
triggersApi.post("/triggers/fire", async ({ body }) => {
  const typedBody = body as TTriggerFireBody;
  const event = typedBody.event as TriggerEvent;
  const ctx: TriggerContext = typedBody.context || {};

  const results = fire(event, ctx);
  return {
    ok: true,
    event,
    fired: results.length,
    results: results.map(r => ({
      action: r.action,
      ok: r.ok,
      output: r.output || null,
      error: r.error || null,
    })),
  };
}, {
  body: TriggerFireBody,
});
