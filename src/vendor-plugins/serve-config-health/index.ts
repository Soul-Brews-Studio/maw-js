import { loadConfig, saveConfig, configForDisplay, resetConfig, type MawConfig } from "maw-js/config";
import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";
import healthHandler from "../../vendor/mpr-plugins/health/index";
import { agentStatusStore as defaultAgentStatusStore, type AgentStatus } from "../../core/agent-status";
import { messageQueue as defaultMessageQueue } from "../../core/message-queue";

const VALID_STATUSES = new Set<AgentStatus>(["busy", "ready", "idle", "crashed", "offline"]);

type AgentStatusStore = Pick<typeof defaultAgentStatusStore, "getAll" | "get" | "report">;
type MessageQueue = Pick<typeof defaultMessageQueue, "pending">;

type ServeHealthDeps = {
  loadConfig: typeof loadConfig;
  saveConfig: typeof saveConfig;
  configForDisplay: typeof configForDisplay;
  resetConfig: typeof resetConfig;
  agentStatusStore: AgentStatusStore;
  messageQueue: MessageQueue;
  healthHandler: typeof healthHandler;
};

type ServeHealthContext = {
  http?: ServeHttpRouteRegistrar;
};

const defaultDeps: ServeHealthDeps = {
  loadConfig,
  saveConfig,
  configForDisplay,
  resetConfig,
  agentStatusStore: defaultAgentStatusStore,
  messageQueue: defaultMessageQueue,
  healthHandler,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function hasMaskedEnvValue(value: unknown): boolean {
  return typeof value === "string" && /\u2022/.test(value);
}

function mergeMaskedEnv(data: Partial<MawConfig>, load: typeof loadConfig): Partial<MawConfig> {
  if (!data.env || typeof data.env !== "object") return data;
  const current = load();
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(data.env as Record<string, string>)) {
    merged[key] = hasMaskedEnvValue(value) ? (current.env[key] || value) : value;
  }
  return { ...data, env: merged };
}

export function createServeHealthRouteHandlers(deps: Partial<ServeHealthDeps> = {}) {
  const d = { ...defaultDeps, ...deps };

  return {
    getConfig: (request: Request) => {
      const url = new URL(request.url);
      if (url.searchParams.get("raw") === "1") return Response.json(d.loadConfig());
      return Response.json(d.configForDisplay());
    },

    postConfig: async (request: Request) => {
      try {
        const body = await readJsonBody(request) as Partial<MawConfig>;
        d.saveConfig(mergeMaskedEnv(body ?? {}, d.loadConfig));
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 400 });
      }
    },

    reloadConfig: () => {
      d.resetConfig();
      return Response.json({ ok: true });
    },

    health: async (request: Request) => {
      const url = new URL(request.url);
      const args = Object.fromEntries(url.searchParams.entries());
      const result = await d.healthHandler({ source: "api", args });
      return Response.json(result);
    },

    getStatus: () => {
      const agents = d.agentStatusStore.getAll();
      const summary: Record<string, number> = {};
      for (const a of agents) summary[a.status] = (summary[a.status] || 0) + 1;
      return Response.json({ agents, summary, total: agents.length });
    },

    getOracleStatus: (_request: Request, oracle: string) => {
      const entry = d.agentStatusStore.get(oracle);
      if (!entry) return Response.json({ error: "not found", oracle });
      const pending = d.messageQueue.pending(oracle);
      return Response.json({ ...entry, pendingMessages: pending.length });
    },

    postStatus: async (request: Request) => {
      const body = await readJsonBody(request) as {
        oracle?: string;
        status?: string;
        sessionId?: string;
        project?: string;
        event?: string;
      } | undefined;
      const oracle = body?.oracle;
      const status = body?.status;
      if (!oracle || !status) return Response.json({ error: "oracle and status required" });
      if (!VALID_STATUSES.has(status as AgentStatus)) {
        return Response.json({ error: `invalid status: ${status}`, valid: [...VALID_STATUSES] });
      }
      d.agentStatusStore.report(oracle, status as AgentStatus, {
        sessionId: body?.sessionId,
        project: body?.project,
        event: body?.event,
      });
      return Response.json({ ok: true, oracle, status });
    },
  };
}

export function registerServeHealthRoutes(http: ServeHttpRouteRegistrar, deps?: Partial<ServeHealthDeps>): void {
  const handlers = createServeHealthRouteHandlers(deps);
  http.route("GET", "/api/config", handlers.getConfig);
  http.route("POST", "/api/config", handlers.postConfig);
  http.route("POST", "/api/config/reload", handlers.reloadConfig);
  http.route("GET", "/api/health", handlers.health);
  http.route("GET", "/health", handlers.health);
  http.route("GET", "/api/status", handlers.getStatus);
  http.route("POST", "/api/status", handlers.postStatus);
  http.route("GET", "/api/status/:oracle", (request) => {
    const oracle = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    return handlers.getOracleStatus(request, oracle);
  });
}

export function serve(ctx: ServeHealthContext): void {
  if (!ctx.http) throw new Error("serve-config-health requires serve http route registration");
  registerServeHealthRoutes(ctx.http);
}

export default serve;
