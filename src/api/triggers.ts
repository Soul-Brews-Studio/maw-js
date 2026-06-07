import { Elysia } from "elysia";
import { getTriggers, getTriggerHistory, fire, type TriggerContext } from "../core/runtime/triggers";
import type { TriggerEvent } from "../config";
import { TriggerFireBody, type TTriggerFireBody } from "../lib/schemas";

export interface TriggersApiDeps {
  getTriggers: typeof getTriggers;
  getTriggerHistory: typeof getTriggerHistory;
  fire: typeof fire;
}

export function createTriggersApi(deps: TriggersApiDeps = {
  getTriggers,
  getTriggerHistory,
  fire,
}) {
  const api = new Elysia();

  /** GET /triggers — list configured triggers + last fired */
  api.get("/triggers", () => {
    const triggers = deps.getTriggers();
    const history = deps.getTriggerHistory();

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
  api.post("/triggers/fire", async ({ body }) => {
    const typedBody = body as TTriggerFireBody;
    const event = typedBody.event as TriggerEvent;
    const ctx: TriggerContext = typedBody.context || {};

    const results = await deps.fire(event, ctx);
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

  return api;
}

export const triggersApi = createTriggersApi();
