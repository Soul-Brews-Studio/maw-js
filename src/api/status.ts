import { Elysia, t } from "elysia";
import { agentStatusStore, type AgentStatus } from "../core/agent-status";

const VALID_STATUSES = new Set<AgentStatus>(["busy", "ready", "idle", "crashed", "offline"]);

export const statusApi = new Elysia()
  .get("/status", () => {
    const agents = agentStatusStore.getAll();
    const summary: Record<string, number> = {};
    for (const a of agents) summary[a.status] = (summary[a.status] || 0) + 1;
    return { agents, summary, total: agents.length };
  })

  .get("/status/:oracle", ({ params }) => {
    const entry = agentStatusStore.get(params.oracle);
    if (!entry) return { error: "not found", oracle: params.oracle };
    return entry;
  })

  .post("/status", ({ body }) => {
    const { oracle, status, sessionId, project, event } = body as {
      oracle: string;
      status: string;
      sessionId?: string;
      project?: string;
      event?: string;
    };
    if (!oracle || !status) return { error: "oracle and status required" };
    if (!VALID_STATUSES.has(status as AgentStatus)) {
      return { error: `invalid status: ${status}`, valid: [...VALID_STATUSES] };
    }
    agentStatusStore.report(oracle, status as AgentStatus, { sessionId, project, event });
    return { ok: true, oracle, status };
  }, {
    body: t.Object({
      oracle: t.String(),
      status: t.String(),
      sessionId: t.Optional(t.String()),
      project: t.Optional(t.String()),
      event: t.Optional(t.String()),
    }),
  });
