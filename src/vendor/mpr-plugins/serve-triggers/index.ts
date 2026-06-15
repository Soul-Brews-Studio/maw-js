import { getTriggerHistory, getTriggers } from "maw-js/sdk";
import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";

type TriggerReadDeps = {
  getTriggers: typeof getTriggers;
  getTriggerHistory: typeof getTriggerHistory;
};

type ServeTriggersContext = {
  http?: ServeHttpRouteRegistrar;
};

export function buildTriggersReadResponse(deps: TriggerReadDeps = {
  getTriggers,
  getTriggerHistory,
}) {
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
}

export function serve(ctx: ServeTriggersContext) {
  if (!ctx.http) throw new Error("serve-triggers requires serve http route registration");
  ctx.http.route("GET", "/api/triggers", () => Response.json(buildTriggersReadResponse()));
}

export default serve;
