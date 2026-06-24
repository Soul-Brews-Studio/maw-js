import { Elysia, t } from "elysia";
import { messageQueue } from "../core/message-queue";
import { getDispatchEngine } from "../core/dispatch-engine";

function bareOracle(name: string): string {
  return name.split(":").at(-1)?.replace(/-oracle$/i, "").trim() || name;
}

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
  .post("/queue", async ({ body }) => {
    const { from, to, target, message } = body as {
      from: string; to: string; target: string; message: string;
    };
    if (!to || !message) return { error: "to and message required" };
    const oracle = bareOracle(to);
    const msg = messageQueue.enqueue({ from, to: oracle, target, message });
    // eq3-003 — surface the 📬 badge the instant a message is deferred (0s delay).
    await getDispatchEngine()?.refreshIndicator(oracle);
    return { ok: true, id: msg.id, oracle };
  }, {
    body: t.Object({
      from: t.String(),
      to: t.String(),
      target: t.String(),
      message: t.String(),
    }),
  })
  // eq3-003 — drain an oracle's deferred queue, re-checking pane-clean before
  // each inject. The Claude Code hook (UserPromptSubmit/Stop) calls this for an
  // instant flush; the periodic sweep is the hook-independent fallback.
  .post("/flush", async ({ body }) => {
    const oracle = bareOracle((body as { oracle: string }).oracle);
    const engine = getDispatchEngine();
    if (!engine) return { ok: false, oracle, error: "dispatch engine not running" };
    const result = await engine.flush(oracle);
    return { ok: true, oracle, ...result };
  }, {
    body: t.Object({ oracle: t.String() }),
  });
