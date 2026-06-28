/**
 * Review Desk — durable human-in-the-loop approval plane.
 *
 * An asker (a fleet oracle) submits a markdown review via `POST /api/review`,
 * gets an immediate ack, and goes on. A human at the Desk decides later
 * (approve / reject / return); the Decision is injected back into the asker's
 * session as a maw message (see api/review.ts). A Round can wait up to 24h, so
 * — unlike the ephemeral 5-min request-reply store (src/core/request-reply.ts)
 * — pending reviews MUST survive a maw restart. This store is therefore backed
 * by bun:sqlite at mawDataPath("review-desk.sqlite"), following the same
 * persistence convention as the message ledger.
 *
 * This module is intentionally pure (store + types + an in-memory event
 * emitter) and has no tmux/dispatch dependency, so it is testable in isolation.
 * Delivery + expiry sweep + HTTP wiring live in src/api/review.ts.
 *
 * 1 Round = 1 correlation. A thread groups the Rounds of one review across
 * return→resubmit cycles (asker reopens with the same threadId).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { mawDataPath } from "./xdg";

export type ReviewContentType = "markdown";
export type ReviewOutcome = "approve" | "reject" | "return" | "expired";
export type ReviewStatus = "pending" | "approved" | "rejected" | "returned" | "expired";

export interface ReviewRow {
  reviewId: string;
  threadId: string;
  roundNo: number;
  corr: string;
  token: string;
  asker: string;
  title: string;
  contextNote: string;
  contentType: ReviewContentType;
  /** Submit-time review body. Immutable — the desk never edits it (ADR-0002). */
  md: string;
  status: ReviewStatus;
  outcome: ReviewOutcome | null;
  /** Reviewer feedback — opaque JSON pass-through (comment + ink + future ui); maw never interprets its shape. */
  feedback: unknown | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/**
 * Pending-list / stream summary — never includes the review body (`md`).
 *
 * Carries the per-Round `token` so a desk-secret holder who lists via /pending
 * (or receives a /stream event) can open GET /:token and decide. /pending and
 * /stream are both desk-secret gated, and desk-secret strictly dominates a lone
 * token, so surfacing the token to those callers is consistent (the Discord
 * capability-link still works token-only). Without this the desk has no path to
 * a token — only the asker gets one, in the POST /review response.
 */
export interface ReviewSummary {
  reviewId: string;
  threadId: string;
  roundNo: number;
  token: string;
  title: string;
  asker: string;
  contextNote: string;
  contentType: ReviewContentType;
  createdAt: string;
  expiresAt: string;
}

export interface ReviewHistoryEntry {
  roundNo: number;
  outcome: ReviewOutcome;
  /** Opaque reviewer feedback for that Round (or null). */
  feedback: unknown | null;
  decidedAt: string | null;
}

export interface CreateReviewInput {
  title: string;
  asker: string;
  contextNote: string;
  md: string;
  contentType?: ReviewContentType;
  deadlineSec?: number;
  threadId?: string | null;
}

export interface DecisionInput {
  outcome: Exclude<ReviewOutcome, "expired">;
  /** Opaque pass-through — stored + relayed verbatim, never validated/interpreted (ADR-0002). */
  feedback?: unknown;
}

export type DecisionError = "not_found" | "already_decided" | "expired";
export interface DecisionResult {
  ok: boolean;
  error?: DecisionError;
  status?: ReviewStatus;
  row?: ReviewRow;
}

export const DEFAULT_DEADLINE_SEC = 86_400; // 24h

interface RawRow {
  review_id: string;
  thread_id: string;
  round_no: number;
  corr: string;
  token: string;
  asker: string;
  title: string;
  context_note: string;
  content_type: string;
  md: string;
  status: string;
  outcome: string | null;
  feedback: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

function hydrate(r: RawRow): ReviewRow {
  return {
    reviewId: r.review_id,
    threadId: r.thread_id,
    roundNo: r.round_no,
    corr: r.corr,
    token: r.token,
    asker: r.asker,
    title: r.title,
    contextNote: r.context_note,
    contentType: r.content_type as ReviewContentType,
    md: r.md,
    status: r.status as ReviewStatus,
    outcome: (r.outcome as ReviewOutcome | null) ?? null,
    feedback: r.feedback != null ? safeJson(r.feedback) : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
  };
}

function safeJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

export function reviewSummary(row: ReviewRow): ReviewSummary {
  return {
    reviewId: row.reviewId,
    threadId: row.threadId,
    roundNo: row.roundNo,
    token: row.token,
    title: row.title,
    asker: row.asker,
    contextNote: row.contextNote,
    contentType: row.contentType,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function outcomeToStatus(outcome: DecisionInput["outcome"]): ReviewStatus {
  return outcome === "approve" ? "approved" : outcome === "reject" ? "rejected" : "returned";
}

/** Constant-time string compare; false on length mismatch (timingSafeEqual throws otherwise). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class ReviewDeskStore {
  private db: Database;

  /** Pass ":memory:" or a temp path in tests; defaults to the durable data path. */
  constructor(dbPath: string = mawDataPath("review-desk.sqlite")) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS reviews (" +
        "review_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, round_no INTEGER NOT NULL, " +
        "corr TEXT NOT NULL, token TEXT NOT NULL, asker TEXT NOT NULL, title TEXT NOT NULL, " +
        "context_note TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'markdown', md TEXT NOT NULL, " +
        "status TEXT NOT NULL, outcome TEXT, feedback TEXT, " +
        "created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT" +
        "); " +
        "CREATE INDEX IF NOT EXISTS idx_reviews_token ON reviews(token); " +
        "CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status); " +
        "CREATE INDEX IF NOT EXISTS idx_reviews_thread ON reviews(thread_id); " +
        "CREATE INDEX IF NOT EXISTS idx_reviews_expires ON reviews(expires_at);",
    );
  }

  create(input: CreateReviewInput): ReviewRow {
    const now = Date.now();
    const deadlineSec = input.deadlineSec && input.deadlineSec > 0 ? input.deadlineSec : DEFAULT_DEADLINE_SEC;
    const threadId = input.threadId || `th_${randomBytes(8).toString("hex")}`;
    const roundNo = input.threadId ? this.nextRoundNo(input.threadId) : 1;
    const row: ReviewRow = {
      reviewId: `rv_${randomBytes(8).toString("hex")}`,
      threadId,
      roundNo,
      corr: `rev-${randomBytes(6).toString("hex")}-${now.toString(36)}`,
      token: randomBytes(32).toString("base64url"), // 256-bit, > 128-bit floor
      asker: input.asker,
      title: input.title,
      contextNote: input.contextNote,
      contentType: input.contentType ?? "markdown",
      md: input.md,
      status: "pending",
      outcome: null,
      feedback: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + deadlineSec * 1000).toISOString(),
      decidedAt: null,
    };
    this.db
      .query(
        "INSERT INTO reviews (review_id, thread_id, round_no, corr, token, asker, title, context_note, content_type, md, status, created_at, expires_at) " +
          "VALUES ($reviewId, $threadId, $roundNo, $corr, $token, $asker, $title, $contextNote, $contentType, $md, 'pending', $createdAt, $expiresAt)",
      )
      .run({
        $reviewId: row.reviewId,
        $threadId: row.threadId,
        $roundNo: row.roundNo,
        $corr: row.corr,
        $token: row.token,
        $asker: row.asker,
        $title: row.title,
        $contextNote: row.contextNote,
        $contentType: row.contentType,
        $md: row.md,
        $createdAt: row.createdAt,
        $expiresAt: row.expiresAt,
      });
    return row;
  }

  private nextRoundNo(threadId: string): number {
    const r = this.db
      .query("SELECT MAX(round_no) AS max FROM reviews WHERE thread_id = $threadId")
      .get({ $threadId: threadId }) as { max?: number | null } | null;
    return (r?.max ?? 0) + 1;
  }

  /** Look up a Round by its opaque token (constant-time guarded). */
  getByToken(token: string): ReviewRow | null {
    const raw = this.db.query("SELECT * FROM reviews WHERE token = $token LIMIT 1").get({ $token: token }) as
      | RawRow
      | null;
    if (!raw || !safeEqual(token, raw.token)) return null;
    return hydrate(raw);
  }

  getByReviewId(reviewId: string): ReviewRow | null {
    const raw = this.db.query("SELECT * FROM reviews WHERE review_id = $id LIMIT 1").get({ $id: reviewId }) as
      | RawRow
      | null;
    return raw ? hydrate(raw) : null;
  }

  pending(): ReviewSummary[] {
    const rows = this.db
      .query("SELECT * FROM reviews WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as RawRow[];
    return rows.map((r) => reviewSummary(hydrate(r)));
  }

  /** Terminal Rounds of a thread before `beforeRoundNo`, oldest first. */
  history(threadId: string, beforeRoundNo: number): ReviewHistoryEntry[] {
    const rows = this.db
      .query(
        "SELECT round_no, outcome, feedback, decided_at FROM reviews " +
          "WHERE thread_id = $threadId AND round_no < $round AND status != 'pending' ORDER BY round_no ASC",
      )
      .all({ $threadId: threadId, $round: beforeRoundNo }) as Array<
      Pick<RawRow, "round_no" | "outcome" | "feedback" | "decided_at">
    >;
    return rows.map((r) => ({
      roundNo: r.round_no,
      outcome: (r.outcome as ReviewOutcome) ?? "expired",
      feedback: r.feedback != null ? safeJson(r.feedback) : null,
      decidedAt: r.decided_at,
    }));
  }

  /**
   * Resolve a decision against a token. Single-use: a Round that is not pending
   * returns `already_decided`; one past its deadline returns `expired`.
   */
  decide(token: string, input: DecisionInput, nowMs: number = Date.now()): DecisionResult {
    const row = this.getByToken(token);
    if (!row) return { ok: false, error: "not_found" };
    if (row.status !== "pending") return { ok: false, error: "already_decided", status: row.status };
    if (nowMs > Date.parse(row.expiresAt)) return { ok: false, error: "expired", status: row.status };

    const status = outcomeToStatus(input.outcome);
    const decidedAt = new Date(nowMs).toISOString();
    this.db
      .query(
        "UPDATE reviews SET status = $status, outcome = $outcome, feedback = $feedback, " +
          "decided_at = $decidedAt WHERE token = $token",
      )
      .run({
        $status: status,
        $outcome: input.outcome,
        $feedback: input.feedback !== undefined ? JSON.stringify(input.feedback) : null,
        $decidedAt: decidedAt,
        $token: token,
      });
    return { ok: true, row: this.getByToken(token)! };
  }

  /** Pending Rounds whose deadline has passed — for the expiry sweep. Marks each `expired`. */
  expireDue(nowMs: number = Date.now()): ReviewRow[] {
    const nowIso = new Date(nowMs).toISOString();
    const raws = this.db
      .query("SELECT * FROM reviews WHERE status = 'pending' AND expires_at <= $now")
      .all({ $now: nowIso }) as RawRow[];
    if (raws.length === 0) return [];
    this.db
      .query("UPDATE reviews SET status = 'expired', outcome = 'expired', decided_at = $now WHERE status = 'pending' AND expires_at <= $now")
      .run({ $now: nowIso });
    return raws.map((r) => hydrate({ ...r, status: "expired", outcome: "expired", decided_at: nowIso }));
  }

  close(): void {
    this.db.close();
  }
}

let singleton: ReviewDeskStore | null = null;
export function reviewDeskStore(): ReviewDeskStore {
  if (!singleton) singleton = new ReviewDeskStore();
  return singleton;
}

// ── SSE event emitter (in-memory; stream subscribers re-snapshot via /pending on reconnect) ──

export type ReviewEventName = "review.created" | "review.decided" | "review.expired";
export interface ReviewEvent {
  name: ReviewEventName;
  summary: ReviewSummary;
}
type ReviewEventListener = (ev: ReviewEvent) => void;

const listeners = new Set<ReviewEventListener>();

export const reviewEvents = {
  add(fn: ReviewEventListener): void {
    listeners.add(fn);
  },
  remove(fn: ReviewEventListener): void {
    listeners.delete(fn);
  },
  emit(name: ReviewEventName, summary: ReviewSummary): void {
    for (const fn of listeners) {
      try {
        fn({ name, summary });
      } catch {
        /* one bad subscriber must not break the rest */
      }
    }
  },
  get size(): number {
    return listeners.size;
  },
};
