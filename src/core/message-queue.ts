export interface QueuedMessage {
  id: string;
  from: string;
  to: string;
  /** Resolved tmux target (session:window) */
  target: string;
  message: string;
  queuedAt: number;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  lastAttempt?: number;
  error?: string;
}

let nextId = 1;

const DEFAULT_TERMINAL_PRUNE_MAX_AGE_MS = 3_600_000;
const DEFAULT_ACTIVE_PRUNE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class MessageQueue {
  private queue: QueuedMessage[] = [];

  enqueue(msg: Omit<QueuedMessage, "id" | "queuedAt" | "status" | "attempts">): QueuedMessage {
    const entry: QueuedMessage = {
      ...msg,
      id: `mq-${nextId++}-${Date.now().toString(36)}`,
      queuedAt: Date.now(),
      status: "pending",
      attempts: 0,
    };
    this.queue.push(entry);
    return entry;
  }

  /** Get pending messages for an oracle, oldest first. */
  pending(oracle: string): QueuedMessage[] {
    return this.queue.filter(m => m.to === oracle && m.status === "pending");
  }

  /** Get next pending message for delivery. */
  next(oracle: string): QueuedMessage | undefined {
    return this.queue.find(m => m.to === oracle && m.status === "pending");
  }

  markDelivering(id: string) {
    const m = this.queue.find(m => m.id === id);
    if (m) { m.status = "delivering"; m.attempts++; m.lastAttempt = Date.now(); }
  }

  markDelivered(id: string) {
    const m = this.queue.find(m => m.id === id);
    if (m) m.status = "delivered";
  }

  markFailed(id: string, error: string) {
    const m = this.queue.find(m => m.id === id);
    if (m) { m.status = "failed"; m.error = error; }
  }

  /** Re-queue a failed message for retry. */
  retry(id: string) {
    const m = this.queue.find(m => m.id === id);
    if (m) { m.status = "pending"; m.error = undefined; }
  }

  getAll(): QueuedMessage[] {
    return [...this.queue];
  }

  /** Prune terminal messages by maxAge and stuck active messages after 24h by default. */
  prune(maxAge = DEFAULT_TERMINAL_PRUNE_MAX_AGE_MS, activeMaxAge = DEFAULT_ACTIVE_PRUNE_MAX_AGE_MS) {
    const now = Date.now();
    const terminalCutoff = now - maxAge;
    const activeCutoff = now - activeMaxAge;

    this.queue = this.queue.filter(m => {
      if (m.status === "pending" || m.status === "delivering") {
        return m.queuedAt > activeCutoff;
      }

      return m.queuedAt > terminalCutoff;
    });
  }

  get size(): number {
    return this.queue.length;
  }

  get pendingCount(): number {
    return this.queue.filter(m => m.status === "pending").length;
  }
}

export const messageQueue = new MessageQueue();
