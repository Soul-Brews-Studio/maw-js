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

  /** Prune delivered/failed messages older than maxAge ms. */
  prune(maxAge = 3_600_000) {
    const cutoff = Date.now() - maxAge;
    this.queue = this.queue.filter(m =>
      m.status === "pending" || m.status === "delivering" || m.queuedAt > cutoff
    );
  }

  get size(): number {
    return this.queue.length;
  }

  get pendingCount(): number {
    return this.queue.filter(m => m.status === "pending").length;
  }
}

export const messageQueue = new MessageQueue();
