import { describe, expect, test } from "bun:test";

import { AgentStatusStore } from "../../src/core/agent-status";
import { MessageQueue } from "../../src/core/message-queue";
import { RequestReplyStore } from "../../src/core/request-reply";

describe("serve memory retention pruning (#2165)", () => {
  test("message queue prune removes completed entries while preserving pending", () => {
    const queue = new MessageQueue();
    const delivered = queue.enqueue({ from: "a", to: "b", target: "sess:1", message: "done" });
    const pending = queue.enqueue({ from: "a", to: "b", target: "sess:1", message: "wait" });
    queue.markDelivered(delivered.id);

    queue.prune(0);

    expect(queue.getAll().map((m) => m.id)).toEqual([pending.id]);
  });

  test("request/reply prune drops entries older than two ttl windows", () => {
    const store = new RequestReplyStore();
    const entry = store.create({ from: "a", to: "b", target: "b", message: "question" });
    entry.createdAt = Date.now() - 10_000;

    store.prune(1_000);

    expect(store.get(entry.correlationId)).toBeUndefined();
  });

  test("agent status prune evicts stale idle/offline entries but keeps live busy entries", () => {
    const store = new AgentStatusStore();
    store.report("old-idle", "idle");
    store.report("live-busy", "busy");
    const oldIdle = store.get("old-idle")!;
    const busy = store.get("live-busy")!;
    oldIdle.updatedAt = Date.now() - 10_000;
    busy.updatedAt = Date.now() - 10_000;

    expect(store.prune(1_000)).toBe(1);

    expect(store.get("old-idle")).toBeUndefined();
    expect(store.get("live-busy")?.status).toBe("busy");
    store.remove("live-busy");
  });
});
