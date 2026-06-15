import { buildAgentRows, loadConfig, tmux } from "maw-js/sdk";
import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";

type AgentsDeps = {
  tmux: Pick<typeof tmux, "listAll" | "listPanes">;
  loadConfig: typeof loadConfig;
  buildAgentRows: typeof buildAgentRows;
};

type ServeAgentsContext = {
  http?: ServeHttpRouteRegistrar;
};

const defaultDeps: AgentsDeps = {
  tmux,
  loadConfig,
  buildAgentRows,
};

function wantsAll(searchParams: URLSearchParams): boolean {
  const all = searchParams.get("all");
  return all === "1" || all === "true";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildAgentsReadResponse(
  request: Request,
  deps: AgentsDeps = defaultDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const all = wantsAll(url.searchParams);
    const config = deps.loadConfig();
    const nodeName = config.node || "local";

    const [sessions, panes] = await Promise.all([
      deps.tmux.listAll(),
      deps.tmux.listPanes(),
    ]);

    const windowNames = new Map<string, string>();
    for (const session of sessions) {
      for (const window of session.windows) {
        windowNames.set(`${session.name}:${window.index}`, window.name);
      }
    }

    const rows = deps.buildAgentRows(panes, windowNames, nodeName, { all });
    return Response.json({ agents: rows, count: rows.length, node: nodeName });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export function registerAgentsRoutes(http: ServeHttpRouteRegistrar, deps?: AgentsDeps): void {
  const handler = (request: Request) => buildAgentsReadResponse(request, deps);
  http.route("GET", "/api/agents", handler);
  http.route("GET", "/api/agent", handler);
}

export function serve(ctx: ServeAgentsContext): void {
  if (!ctx.http) throw new Error("serve-agents requires serve http route registration");
  registerAgentsRoutes(ctx.http);
}

export default serve;
