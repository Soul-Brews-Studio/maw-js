import { describe, test, expect, beforeEach } from "bun:test";
import { MessageQueue } from "../../src/core/message-queue";

describe("MessageQueue", () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  test("enqueue adds a message with pending status", () => {
    const msg = queue.enqueue({ from: "a:sender", to: "neo", target: "s:neo-oracle", message: "hello" });
    expect(msg.status).toBe("pending");
    expect(msg.attempts).toBe(0);
    expect(msg.id).toMatch(/^mq-/);
  });

  test("pending returns only pending messages for oracle", () => {
    queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m1" });
    queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m2" });
    queue.enqueue({ from: "a:s", to: "morpheus", target: "s:morpheus", message: "m3" });

    expect(queue.pending("neo")).toHaveLength(2);
    expect(queue.pending("morpheus")).toHaveLength(1);
    expect(queue.pending("trinity")).toHaveLength(0);
  });

  test("next returns oldest pending message", () => {
    queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "first" });
    queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "second" });

    const next = queue.next("neo");
    expect(next?.message).toBe("first");
  });

  test("markDelivering updates status and increments attempts", () => {
    const msg = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m1" });
    queue.markDelivering(msg.id);

    const all = queue.getAll();
    expect(all[0].status).toBe("delivering");
    expect(all[0].attempts).toBe(1);
  });

  test("markDelivered updates status", () => {
    const msg = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m1" });
    queue.markDelivered(msg.id);
    expect(queue.getAll()[0].status).toBe("delivered");
  });

  test("markFailed updates status and error", () => {
    const msg = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m1" });
    queue.markFailed(msg.id, "tmux error");
    expect(queue.getAll()[0].status).toBe("failed");
    expect(queue.getAll()[0].error).toBe("tmux error");
  });

  test("retry re-queues a failed message", () => {
    const msg = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m1" });
    queue.markFailed(msg.id, "err");
    queue.retry(msg.id);
    expect(queue.getAll()[0].status).toBe("pending");
    expect(queue.getAll()[0].error).toBeUndefined();
  });


  test("prune removes pending and delivering messages stuck longer than active max age", () => {
    const stalePending = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "stale pending" });
    const staleDelivering = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "stale delivering" });
    const freshPending = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "fresh pending" });

    queue.markDelivering(staleDelivering.id);
    stalePending.queuedAt = Date.now() - 25 * 60 * 60 * 1000;
    staleDelivering.queuedAt = Date.now() - 25 * 60 * 60 * 1000;

    queue.prune();

    expect(queue.getAll().map(m => m.message)).toEqual(["fresh pending"]);
  });

  test("prune keeps pending and delivering messages newer than active max age", () => {
    const pending = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "pending" });
    const delivering = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "delivering" });

    queue.markDelivering(delivering.id);
    pending.queuedAt = Date.now() - 23 * 60 * 60 * 1000;
    delivering.queuedAt = Date.now() - 23 * 60 * 60 * 1000;

    queue.prune();

    expect(queue.getAll().map(m => m.message)).toEqual(["pending", "delivering"]);
  });

  test("pendingCount and size", () => {
    queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m1" });
    const m2 = queue.enqueue({ from: "a:s", to: "neo", target: "s:neo", message: "m2" });
    queue.markDelivered(m2.id);

    expect(queue.size).toBe(2);
    expect(queue.pendingCount).toBe(1);
  });
});
