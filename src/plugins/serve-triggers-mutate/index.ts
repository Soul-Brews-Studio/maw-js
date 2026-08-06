import { fire } from "maw-js/sdk";
import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";

type TriggerFireDeps = {
  fire: typeof fire;
};

type ServeTriggersMutateContext = {
  http?: ServeHttpRouteRegistrar;
};

type TriggerFireBody = {
  event?: unknown;
  context?: unknown;
};

type TriggerContext = Record<string, string | undefined>;

const defaultDeps: TriggerFireDeps = { fire };

function isTriggerContext(value: unknown): value is TriggerContext {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>)
    .every((entry) => entry === undefined || typeof entry === "string");
}

async function readJsonBody(request: Request): Promise<TriggerFireBody | undefined> {
  try {
    return await request.json() as TriggerFireBody;
  } catch {
    return undefined;
  }
}

export function createTriggerMutateRouteHandlers(deps: TriggerFireDeps = defaultDeps) {
  return {
    fire: async (request: Request) => {
      const body = await readJsonBody(request);
      if (typeof body?.event !== "string") {
        return Response.json({ error: "event is required" }, { status: 400 });
      }
      if (!isTriggerContext(body.context)) {
        return Response.json({ error: "context must be an object of string values" }, { status: 400 });
      }

      const event = body.event as Parameters<typeof deps.fire>[0];
      const ctx = (body.context || {}) as Parameters<typeof deps.fire>[1];
      const results = await deps.fire(event, ctx);
      return Response.json({
        ok: true,
        event,
        fired: results.length,
        results: results.map(r => ({
          action: r.action,
          ok: r.ok,
          output: r.output || null,
          error: r.error || null,
        })),
      });
    },
  };
}

export function registerTriggerMutateRoutes(http: ServeHttpRouteRegistrar, deps?: TriggerFireDeps): void {
  const handlers = createTriggerMutateRouteHandlers(deps);
  http.route("POST", "/api/triggers/fire", handlers.fire);
}

export function serve(ctx: ServeTriggersMutateContext): void {
  if (!ctx.http) throw new Error("serve-triggers-mutate requires serve http route registration");
  registerTriggerMutateRoutes(ctx.http);
}

export default serve;
