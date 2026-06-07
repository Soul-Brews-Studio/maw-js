import { Elysia } from "elysia";
import { fire, type TriggerContext } from "../core/runtime/triggers";
import type { TriggerEvent } from "../config";
import { TriggerFireBody, type TTriggerFireBody } from "../lib/schemas";

export interface TriggersApiDeps {
  fire: typeof fire;
}

export function createTriggersApi(deps: TriggersApiDeps = {
  fire,
}) {
  const api = new Elysia();

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
