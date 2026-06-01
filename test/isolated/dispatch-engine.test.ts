import { describe, test, expect, beforeEach } from "bun:test";
import { AgentStatusStore } from "../../src/core/agent-status";
import { MessageQueue } from "../../src/core/message-queue";

describe("Dispatch Engine — status onChange + queue integration", () => {
  let store: AgentStatusStore;
  let queue: MessageQueue;

  beforeEach(() => {
    store = new AgentStatusStore();
    queue = new MessageQueue();
  });

  test("onChange fires on status transition", () => {
    const transitions: [string, string | null, string][] = [];
    store.onChange((oracle, from, to) => transitions.push([oracle, from, to]));

    store.report("neo", "busy");
    store.report("neo", "ready");

    expect(transitions).toEqual([
      ["neo", null, "busy"],
      ["neo", "busy", "ready"],
    ]);
  });

  test("onChange does not fire when status unchanged", () => {
    const transitions: [string, string | null, string][] = [];
    store.onChange((oracle, from, to) => transitions.push([oracle, from, to]));

    store.report("neo", "busy");
    store.report("neo", "busy");

    expect(transitions).toEqual([["neo", null, "busy"]]);
  });

  test("queue delivers on busy→ready transition", async () => {
    const delivered: string[] = [];
    const mockSendKeys = async (_target: string, text: string) => { delivered.push(text); };

    queue.enqueue({ from: "a:sender", to: "neo", target: "s:neo-oracle", message: "hello neo" });

    store.onChange((_oracle, from, to) => {
      if (from === "busy" && (to === "ready" || to === "idle")) {
        const msg = queue.next(_oracle);
        if (msg) {
          queue.markDelivering(msg.id);
          mockSendKeys(msg.target, msg.message).then(() => queue.markDelivered(msg.id));
        }
      }
    });

    store.report("neo", "busy");
    store.report("neo", "ready");

    await Bun.sleep(10); // let async sendKeys resolve
    expect(delivered).toEqual(["hello neo"]);
    expect(queue.getAll()[0].status).toBe("delivered");
  });

  test("no delivery when transitioning to busy", () => {
    const delivered: string[] = [];
    queue.enqueue({ from: "a:sender", to: "neo", target: "s:neo", message: "msg" });

    store.onChange((_oracle, from, to) => {
      if (from === "busy" && (to === "ready" || to === "idle")) {
        delivered.push("would deliver");
      }
    });

    store.report("neo", "idle");
    store.report("neo", "busy"); // should NOT trigger delivery

    expect(delivered).toEqual([]);
  });
});
