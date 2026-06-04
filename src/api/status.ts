import { Elysia, t } from "elysia";
import { agentStatusStore, type AgentStatus } from "../core/agent-status";
import { messageQueue } from "../core/message-queue";
import { resetConfig } from "../config/load";

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
    const pending = messageQueue.pending(params.oracle);
    return { ...entry, pendingMessages: pending.length };
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
  })

  .get("/queue", () => {
    const all = messageQueue.getAll();
    return {
      messages: all,
      pending: messageQueue.pendingCount,
      total: messageQueue.size,
    };
  })

  .get("/queue/:oracle", ({ params }) => {
    const pending = messageQueue.pending(params.oracle);
    return { oracle: params.oracle, pending, count: pending.length };
  })

  .post("/config/reload", () => {
    resetConfig();
    return { ok: true };
  })

  .post("/queue", ({ body }) => {
    const { from, to, target, message } = body as {
      from: string; to: string; target: string; message: string;
    };
    if (!to || !message) return { error: "to and message required" };
    const oracle = to.split(":").at(-1)?.replace(/-oracle$/i, "").trim() || to;
    const msg = messageQueue.enqueue({ from, to: oracle, target, message });
    return { ok: true, id: msg.id, oracle };
  }, {
    body: t.Object({
      from: t.String(),
      to: t.String(),
      target: t.String(),
      message: t.String(),
    }),
  });
