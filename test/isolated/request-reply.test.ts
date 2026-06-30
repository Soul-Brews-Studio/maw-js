import { describe, test, expect, beforeEach } from "bun:test";
import { RequestReplyStore } from "../../src/core/request-reply";

describe("RequestReplyStore", () => {
  let store: RequestReplyStore;

  beforeEach(() => {
    store = new RequestReplyStore();
  });

  test("create returns entry with correlationId", () => {
    const entry = store.create({ from: "client", to: "neo", target: "neo", message: "hello" });
    expect(entry.correlationId).toMatch(/^req-/);
    expect(entry.status).toBe("pending");
    expect(entry.from).toBe("client");
    expect(entry.to).toBe("neo");
  });

  test("get retrieves by correlationId", () => {
    const entry = store.create({ from: "client", to: "neo", target: "neo", message: "hello" });
    const found = store.get(entry.correlationId);
    expect(found).toBeDefined();
    expect(found!.message).toBe("hello");
  });

  test("get returns undefined for unknown id", () => {
    expect(store.get("unknown")).toBeUndefined();
  });

  test("markDelivered updates status", () => {
    const entry = store.create({ from: "c", to: "neo", target: "neo", message: "m" });
    store.markDelivered(entry.correlationId);
    expect(store.get(entry.correlationId)!.status).toBe("delivered");
    expect(store.get(entry.correlationId)!.deliveredAt).toBeDefined();
  });

  test("markReplied updates status and reply", () => {
    const entry = store.create({ from: "c", to: "neo", target: "neo", message: "m" });
    store.markReplied(entry.correlationId, "done", { result: 42 });
    const got = store.get(entry.correlationId)!;
    expect(got.status).toBe("replied");
    expect(got.reply).toBe("done");
    expect(got.replyData).toEqual({ result: 42 });
  });

  test("markFailed updates status and error", () => {
    const entry = store.create({ from: "c", to: "neo", target: "neo", message: "m" });
    store.markFailed(entry.correlationId, "timeout");
    expect(store.get(entry.correlationId)!.status).toBe("failed");
    expect(store.get(entry.correlationId)!.error).toBe("timeout");
  });

  test("pendingFor returns pending and delivered entries for oracle", () => {
    store.create({ from: "c", to: "neo", target: "neo", message: "m1" });
    store.create({ from: "c", to: "neo", target: "neo", message: "m2" });
    store.create({ from: "c", to: "morpheus", target: "morpheus", message: "m3" });

    expect(store.pendingFor("neo")).toHaveLength(2);
    expect(store.pendingFor("morpheus")).toHaveLength(1);
    expect(store.pendingFor("trinity")).toHaveLength(0);
  });

  test("pendingFor excludes replied entries", () => {
    const e1 = store.create({ from: "c", to: "neo", target: "neo", message: "m1" });
    store.create({ from: "c", to: "neo", target: "neo", message: "m2" });
    store.markReplied(e1.correlationId, "done");

    expect(store.pendingFor("neo")).toHaveLength(1);
  });

  test("getAll returns all entries", () => {
    store.create({ from: "c", to: "neo", target: "neo", message: "m1" });
    store.create({ from: "c", to: "morpheus", target: "morpheus", message: "m2" });
    expect(store.getAll()).toHaveLength(2);
  });

  test("register uses the EXPLICIT correlationId (maw hey [request:id] path)", () => {
    const e = store.register({ correlationId: "t-1", from: "lek", to: "kang", target: "kang", message: "x" });
    expect(e.correlationId).toBe("t-1");
    expect(e.status).toBe("pending");
    expect(store.get("t-1")).toBeDefined();
    expect(store.pendingFor("kang")).toHaveLength(1); // visible to reply --list
  });

  test("register is idempotent — re-register never resets status or clobbers a reply", () => {
    store.register({ correlationId: "t-2", from: "lek", to: "kang", target: "kang", message: "first" });
    store.markReplied("t-2", "pong");
    const again = store.register({ correlationId: "t-2", from: "lek", to: "kang", target: "kang", message: "first" });
    expect(again.status).toBe("replied"); // untouched
    expect(again.reply).toBe("pong");
    expect(store.getAll().filter((e) => e.correlationId === "t-2")).toHaveLength(1); // no dup
  });
});
