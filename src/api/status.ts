import { Elysia, t } from "elysia";
import { messageQueue } from "../core/message-queue";

export const statusApi = new Elysia()
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
