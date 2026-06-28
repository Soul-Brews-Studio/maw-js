/**
 * Review Desk API — human-in-the-loop markdown approval gate.
 *
 * An asker (fleet oracle) submits a review via POST /api/review and gets an
 * immediate ack (non-blocking — it does NOT hold an HTTP connection). A human
 * at the Desk decides later; the Decision is injected back into the asker's
 * session via the dispatch engine (the same path as `maw hey` / inbound
 * requests) — NOT via the ephemeral /api/reply plane, whose 5-min corr would be
 * long gone before a 24h decision. Pending reviews are durable (review-desk.ts
 * → bun:sqlite) so they survive a maw restart.
 *
 *   POST  /api/review                  asker → maw   (mint corr+token, store, SSE created)
 *   GET   /api/review/pending          desk secret   (snapshot, no md)
 *   GET   /api/review/stream           desk secret   (SSE delta + heartbeat)
 *   GET   /api/review/:token           token         (full envelope + history)
 *   POST  /api/review/:token/decision  token         (resolve → deliver → SSE decided)
 *   (expiry sweep)                     internal       (mark expired → deliver → SSE expired; never auto-approve)
 *
 * Cross-node caveat: auto-inject works when the asker is a local pane on this
 * maw node. A cross-node asker should poll GET /api/review/:token instead.
 */

import { Elysia, t } from "elysia";
import {
  reviewDeskStore,
  reviewEvents,
  reviewSummary,
  safeEqual,
  type ReviewEvent,
  type ReviewRow,
} from "../core/review-desk";

// NB: the delivery deps (config, routing, transport, message-queue) are loaded
// DYNAMICALLY inside deliverDecisionToAsker — not statically — to keep `../config`
// (which transitively pulls the transports/scout link graph) out of this module's
// static surface. A static import drags that whole graph into api/index.ts and
// breaks isolated tests that partially mock api/pair (scout imports recordHelloZid
// from it). Same rationale as server.ts's dynamic comm-send/tmux imports.

const HEARTBEAT_MS = 20_000; // SSE keepalive — beats proxy idle-cut (traefik/cloudflare)
const MAX_MD_BYTES = 256 * 1024;
const MAX_FEEDBACK_BYTES = 256 * 1024; // opaque feedback blob cap (comment + ink)
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30; // POST /api/review per asker per window

// ── auth ──

function deskSecret(): string | null {
  return process.env.MAW_REVIEW_DESK_SECRET || null;
}

function checkDeskSecret(request: Request): boolean {
  const secret = deskSecret();
  if (!secret) return false;
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? safeEqual(m[1], secret) : false;
}

function deskUrl(token: string): string {
  const base = (process.env.MAW_REVIEW_DESK_URL || "").replace(/\/$/, "");
  return base ? `${base}/r/${token}` : `/r/${token}`;
}

// ── per-asker rate limit (in-memory sliding window) ──

const rateHits = new Map<string, number[]>();
function rateOk(asker: string, nowMs = Date.now()): boolean {
  const cutoff = nowMs - RATE_WINDOW_MS;
  const hits = (rateHits.get(asker) || []).filter((t) => t > cutoff);
  if (hits.length >= RATE_MAX) {
    rateHits.set(asker, hits);
    return false;
  }
  hits.push(nowMs);
  rateHits.set(asker, hits);
  return true;
}

// ── Decision payload + delivery ──

interface DecisionPayload {
  type: "review.decision";
  reviewId: string;
  threadId: string;
  roundNo: number;
  outcome: ReviewRow["outcome"];
  /** Opaque reviewer feedback (comment + ink + future ui); omitted when absent. No `md` — desk is read-only (ADR-0002). */
  feedback?: unknown;
}

function buildDecisionPayload(row: ReviewRow): DecisionPayload {
  const payload: DecisionPayload = {
    type: "review.decision",
    reviewId: row.reviewId,
    threadId: row.threadId,
    roundNo: row.roundNo,
    outcome: row.outcome,
  };
  if (row.feedback != null) payload.feedback = row.feedback;
  return payload;
}

function formatDecisionMessage(p: DecisionPayload): string {
  return `🍵 [review.decision] ${p.outcome} — reviewId=${p.reviewId} round ${p.roundNo}\n${JSON.stringify(p)}`;
}

/**
 * Deliver a Decision into the asker's session via the dispatch engine
 * (messageQueue → DispatchEngine.sendKeys, zero-overtype guarded). Local panes
 * only; cross-node / unresolved askers fall back to polling GET /:token.
 */
async function deliverDecisionToAsker(
  asker: string,
  payload: DecisionPayload,
): Promise<{ delivered: boolean; reason?: string }> {
  try {
    const [{ loadConfig }, { listSessions }, { resolveTarget }, { messageQueue }, { extractOracleName }] =
      await Promise.all([
        import("../config"),
        import("../core/transport/ssh"),
        import("../core/routing"),
        import("../core/message-queue"),
        import("../core/agent-status-guard"),
      ]);
    const config = loadConfig();
    const sessions = await listSessions();
    const result = resolveTarget(asker, config, sessions);
    if (!result || result.type === "error") {
      return { delivered: false, reason: result?.detail ?? "asker unresolved" };
    }
    if (result.type === "peer") {
      return { delivered: false, reason: "cross-node asker — poll GET /api/review/:token" };
    }
    const { resolveOraclePane } = await import("../commands/shared/comm-send");
    const target = await resolveOraclePane(result.target);
    messageQueue.enqueue({
      from: "review-desk",
      to: extractOracleName(asker),
      target,
      message: formatDecisionMessage(payload),
    });
    return { delivered: true };
  } catch (e) {
    return { delivered: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── expiry sweep (internal background; never auto-approves) ──

export async function runReviewExpirySweepOnce(nowMs: number = Date.now()): Promise<number> {
  const due = reviewDeskStore().expireDue(nowMs);
  for (const row of due) {
    await deliverDecisionToAsker(row.asker, buildDecisionPayload(row)); // best-effort
    reviewEvents.emit("review.expired", reviewSummary(row));
  }
  return due.length;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startReviewExpirySweep(intervalMs = 60_000): void {
  if (sweepTimer || intervalMs <= 0) return;
  sweepTimer = setInterval(() => {
    void runReviewExpirySweepOnce();
  }, intervalMs);
  (sweepTimer as { unref?: () => void }).unref?.();
}

// ── routes ──

export const reviewApi = new Elysia()
  /** POST /api/review — asker submits a review; non-blocking ack. */
  .post(
    "/review",
    ({ body, set }) => {
      // Rate-limit first so malformed (but schema-valid) floods also consume quota.
      if (!rateOk(body.asker)) {
        set.status = 429;
        return { error: "rate limit exceeded for asker" };
      }
      const contentType = body.contentType ?? "markdown";
      if (contentType !== "markdown") {
        set.status = 400;
        return { error: `unsupported contentType '${contentType}' — only 'markdown' in v0` };
      }
      if (!body.md || body.md.trim() === "") {
        set.status = 400;
        return { error: "md is required for contentType=markdown" };
      }
      if (Buffer.byteLength(body.md, "utf8") > MAX_MD_BYTES) {
        set.status = 413;
        return { error: `md exceeds ${MAX_MD_BYTES} bytes` };
      }
      if (!body.title || !body.contextNote) {
        set.status = 400;
        return { error: "title, asker, contextNote are required" };
      }
      const row = reviewDeskStore().create({
        title: body.title,
        asker: body.asker,
        contextNote: body.contextNote,
        md: body.md,
        contentType: "markdown",
        deadlineSec: body.deadlineSec,
        threadId: body.threadId ?? null,
      });
      reviewEvents.emit("review.created", reviewSummary(row));
      return {
        reviewId: row.reviewId,
        threadId: row.threadId,
        roundNo: row.roundNo,
        token: row.token,
        url: deskUrl(row.token),
        corr: row.corr,
        expiresAt: row.expiresAt,
      };
    },
    {
      body: t.Object({
        title: t.String(),
        asker: t.String(),
        contextNote: t.String(),
        md: t.Optional(t.String()),
        contentType: t.Optional(t.String()),
        deadlineSec: t.Optional(t.Number()),
        threadId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  /** GET /api/review/pending — desk snapshot (summaries, no md). Static route before /:token. */
  .get("/review/pending", ({ request, set }) => {
    if (!checkDeskSecret(request)) {
      set.status = 401;
      return { error: "desk secret required" };
    }
    return { pending: reviewDeskStore().pending() };
  })

  /** GET /api/review/stream — SSE delta stream + heartbeat. Static route before /:token. */
  .get("/review/stream", ({ request, set }) => {
    if (!checkDeskSecret(request)) {
      set.status = 401;
      return { error: "desk secret required" };
    }
    let hb: ReturnType<typeof setInterval> | undefined;
    let listener: ((ev: ReviewEvent) => void) | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const write = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            /* connection closed */
          }
        };
        write(": connected\n\n");
        listener = (ev) => write(`event: ${ev.name}\ndata: ${JSON.stringify(ev.summary)}\n\n`);
        reviewEvents.add(listener);
        hb = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
        (hb as { unref?: () => void }).unref?.();
      },
      cancel() {
        if (hb) clearInterval(hb);
        if (listener) reviewEvents.remove(listener);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  })

  /**
   * GET /api/review/:token — full envelope + thread history.
   * The token IS the capability (no extra auth). It rides in the URL path, so
   * callers/proxies must not log it or leak it via Referer (capability-URL caveat).
   */
  .get("/review/:token", ({ params, set }) => {
    const store = reviewDeskStore();
    const row = store.getByToken(params.token);
    if (!row) {
      set.status = 404;
      return { error: "review not found" };
    }
    return {
      reviewId: row.reviewId,
      threadId: row.threadId,
      roundNo: row.roundNo,
      title: row.title,
      asker: row.asker,
      contextNote: row.contextNote,
      contentType: row.contentType,
      md: row.md,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      status: row.status,
      outcome: row.outcome,
      history: store.history(row.threadId, row.roundNo),
    };
  })

  /** POST /api/review/:token/decision — resolve token→corr, deliver Decision, mark terminal. */
  .post(
    "/review/:token/decision",
    async ({ params, body, set }) => {
      const outcome = body.outcome;
      if (outcome !== "approve" && outcome !== "reject" && outcome !== "return") {
        set.status = 400;
        return { error: "outcome must be approve | reject | return" };
      }
      if (body.feedback !== undefined && Buffer.byteLength(JSON.stringify(body.feedback), "utf8") > MAX_FEEDBACK_BYTES) {
        set.status = 413;
        return { error: `feedback exceeds ${MAX_FEEDBACK_BYTES} bytes` };
      }
      const res = reviewDeskStore().decide(params.token, { outcome, feedback: body.feedback });
      if (!res.ok) {
        if (res.error === "not_found") {
          set.status = 404;
          return { error: "review not found" };
        }
        set.status = 409;
        return { error: res.error === "expired" ? "review expired" : "already decided", status: res.status };
      }
      const row = res.row!;
      const delivery = await deliverDecisionToAsker(row.asker, buildDecisionPayload(row));
      reviewEvents.emit("review.decided", reviewSummary(row));
      return {
        ok: true,
        outcome: row.outcome,
        delivered: delivery.delivered,
        ...(delivery.delivered ? {} : { deliveryNote: delivery.reason }),
      };
    },
    {
      body: t.Object({
        outcome: t.String(),
        feedback: t.Optional(t.Unknown()),
      }),
    },
  );
