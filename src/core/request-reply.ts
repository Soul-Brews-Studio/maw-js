/**
 * Request-Reply store — tracks pending requests with correlationIds.
 *
 * Flow:
 * 1. External client calls POST /api/request → gets correlationId
 * 2. maw delivers request to target oracle
 * 3. Oracle processes and calls POST /api/reply/:correlationId
 * 4. External client polls GET /api/request/:correlationId → gets reply
 */

export type RequestStatus = "pending" | "delivered" | "replied" | "failed" | "expired";

export interface RequestEntry {
  correlationId: string;
  from: string;
  to: string;
  target: string;
  message: string;
  status: RequestStatus;
  createdAt: number;
  deliveredAt?: number;
  repliedAt?: number;
  reply?: string;
  replyData?: unknown;
  error?: string;
  /** Callback URL for push-based reply delivery */
  callbackUrl?: string;
}

const EXPIRY_MS = 300_000; // 5 min default TTL

let nextSeq = 1;

function generateCorrelationId(): string {
  return `req-${nextSeq++}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RequestReplyStore {
  private store = new Map<string, RequestEntry>();

  create(opts: {
    from: string;
    to: string;
    target: string;
    message: string;
    callbackUrl?: string;
  }): RequestEntry {
    const correlationId = generateCorrelationId();
    const entry: RequestEntry = {
      correlationId,
      from: opts.from,
      to: opts.to,
      target: opts.target,
      message: opts.message,
      status: "pending",
      createdAt: Date.now(),
      callbackUrl: opts.callbackUrl,
    };
    this.store.set(correlationId, entry);
    return entry;
  }

  /**
   * Register a request under an EXPLICIT correlationId — used by the
   * `maw hey [request:<id>]` convention so the dispatched id is trackable by
   * `maw reply` / `reply --list` (the in-band path never hit POST /api/request,
   * so the store was empty). Idempotent: re-registering an existing id returns
   * it untouched, so a re-send never resets status or clobbers a reply.
   */
  register(opts: {
    correlationId: string;
    from: string;
    to: string;
    target: string;
    message: string;
  }): RequestEntry {
    const existing = this.store.get(opts.correlationId);
    if (existing) return existing;
    const entry: RequestEntry = {
      correlationId: opts.correlationId,
      from: opts.from,
      to: opts.to,
      target: opts.target,
      message: opts.message,
      status: "pending",
      createdAt: Date.now(),
    };
    this.store.set(opts.correlationId, entry);
    return entry;
  }

  get(correlationId: string): RequestEntry | undefined {
    return this.store.get(correlationId);
  }

  markDelivered(correlationId: string) {
    const entry = this.store.get(correlationId);
    if (entry) { entry.status = "delivered"; entry.deliveredAt = Date.now(); }
  }

  markReplied(correlationId: string, reply: string, data?: unknown) {
    const entry = this.store.get(correlationId);
    if (entry) {
      entry.status = "replied";
      entry.repliedAt = Date.now();
      entry.reply = reply;
      entry.replyData = data;
    }
  }

  markFailed(correlationId: string, error: string) {
    const entry = this.store.get(correlationId);
    if (entry) { entry.status = "failed"; entry.error = error; }
  }

  /** Get all pending requests for an oracle (so it can reply to them). */
  pendingFor(oracle: string): RequestEntry[] {
    return [...this.store.values()].filter(
      e => e.to === oracle && (e.status === "pending" || e.status === "delivered")
    );
  }

  /** Prune expired entries. */
  prune(ttl = EXPIRY_MS) {
    const cutoff = Date.now() - ttl;
    for (const [id, entry] of this.store) {
      if (entry.createdAt < cutoff && entry.status !== "replied") {
        entry.status = "expired";
      }
      // Remove fully expired entries older than 2x TTL
      if (entry.createdAt < cutoff - ttl) {
        this.store.delete(id);
      }
    }
  }

  getAll(): RequestEntry[] {
    return [...this.store.values()];
  }
}

export const requestReplyStore = new RequestReplyStore();
