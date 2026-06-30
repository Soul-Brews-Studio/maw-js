import { Elysia, t } from "elysia";
import { requestReplyStore } from "../core/request-reply";
import { agentStatusStore } from "../core/agent-status";
import { messageQueue } from "../core/message-queue";
import { extractOracleName } from "../core/agent-status-guard";
import { pushFeedEvent } from "./feed";
import { buildMessageLifecycleFeedEvent } from "../lib/message-events";
import { parsePrNumber, setTaskPr } from "../core/tasks/store";
import { findByRequestId } from "../core/tasks/auto-create";
import { companyOfOracle } from "../core/worklog/company-scope";

const ALLOWED_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isAllowedCallbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return ALLOWED_CALLBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export const requestReplyApi = new Elysia()
  /**
   * POST /api/request — submit a request to an oracle.
   * Returns a correlationId for polling the reply.
   */
  .post("/request", async ({ body, set }) => {
    const { to, message, callbackUrl } = body;
    const from = body.from || "external";
    const oracle = extractOracleName(to);

    const entry = requestReplyStore.create({
      from,
      to: oracle,
      target: to,
      message,
      callbackUrl,
    });

    // Check if target is busy → queue for later delivery
    const status = agentStatusStore.get(oracle);
    if (status?.status === "busy") {
      messageQueue.enqueue({
        from,
        to: oracle,
        target: to,
        message: `[request:${entry.correlationId}] ${message}`,
      });
      return {
        correlationId: entry.correlationId,
        status: "queued",
        message: `target '${oracle}' is busy; request queued for delivery`,
      };
    }

    // Deliver immediately via feed event (the actual sendKeys is done by the caller or dispatch engine)
    requestReplyStore.markDelivered(entry.correlationId);

    try {
      pushFeedEvent(buildMessageLifecycleFeedEvent({
        direction: "inbound",
        state: "delivered",
        channel: "request",
        route: "local",
        from,
        to: oracle,
        target: to,
        text: message,
        lastLine: `correlationId=${entry.correlationId}`,
        signed: false,
      }));
    } catch {}

    return {
      correlationId: entry.correlationId,
      status: "delivered",
      oracle,
    };
  }, {
    body: t.Object({
      to: t.String(),
      message: t.String(),
      from: t.Optional(t.String()),
      callbackUrl: t.Optional(t.String()),
    }),
  })

  /**
   * POST /api/request/track — register an in-band `[request:<id>]` dispatch
   * (from `maw hey`/`send`) into the store under its EXISTING correlationId, so
   * `maw reply <id>` / `reply --list` can find it. Idempotent. No delivery side
   * effects — the hey already delivered via the inbox/pane path.
   */
  .post("/request/track", ({ body }) => {
    const oracle = extractOracleName(body.to);
    const entry = requestReplyStore.register({
      correlationId: body.correlationId,
      from: body.from || "unknown",
      to: oracle,
      target: body.to,
      message: body.message ?? "",
    });
    return { correlationId: entry.correlationId, status: entry.status, to: entry.to };
  }, {
    body: t.Object({
      correlationId: t.String(),
      to: t.String(),
      from: t.Optional(t.String()),
      message: t.Optional(t.String()),
    }),
  })

  /**
   * GET /api/request/:correlationId — poll for reply.
   */
  .get("/request/:correlationId", ({ params, set }) => {
    const entry = requestReplyStore.get(params.correlationId);
    if (!entry) { set.status = 404; return { error: "request not found" }; }
    return entry;
  })

  /**
   * POST /api/reply/:correlationId — oracle submits a reply.
   */
  .post("/reply/:correlationId", async ({ params, body, set }) => {
    const entry = requestReplyStore.get(params.correlationId);
    if (!entry) { set.status = 404; return { error: "request not found" }; }
    if (entry.status === "replied") { return { error: "already replied", correlationId: params.correlationId }; }

    requestReplyStore.markReplied(params.correlationId, body.reply, body.data);

    // Track 4 — "done my part, PR up, review me": if the reply carries a PR url
    // and this correlationId maps to an auto-created task, attach the PR + move
    // the card to review (PR-watch flips it to done on merge). Best-effort.
    try {
      const pr = parsePrNumber(body.reply);
      if (pr != null) {
        const company = companyOfOracle(entry.from);
        if (company) {
          const task = findByRequestId(company, params.correlationId);
          if (task) setTaskPr(company, task.id, pr, entry.to);
        }
      }
    } catch { /* never let task wiring break the reply */ }

    // Push-based callback if configured (SSRF guard: localhost only)
    if (entry.callbackUrl && isAllowedCallbackUrl(entry.callbackUrl)) {
      try {
        await fetch(entry.callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            correlationId: params.correlationId,
            reply: body.reply,
            data: body.data,
            from: entry.to,
            to: entry.from,
          }),
        });
      } catch {}
    }

    try {
      pushFeedEvent(buildMessageLifecycleFeedEvent({
        direction: "outbound",
        state: "delivered",
        channel: "reply",
        route: "local",
        from: entry.to,
        to: entry.from,
        target: entry.target,
        text: body.reply,
        lastLine: `correlationId=${params.correlationId}`,
        signed: false,
      }));
    } catch {}

    return { ok: true, correlationId: params.correlationId };
  }, {
    body: t.Object({
      reply: t.String(),
      data: t.Optional(t.Unknown()),
    }),
  })

  /**
   * GET /api/requests — list all requests (optionally filtered by oracle).
   */
  .get("/requests", ({ query }) => {
    let all = requestReplyStore.getAll();
    if (query.oracle) all = all.filter(e => e.to === query.oracle);
    if (query.status) all = all.filter(e => e.status === query.status);
    return { requests: all, total: all.length };
  }, {
    query: t.Object({
      oracle: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }),
  });
