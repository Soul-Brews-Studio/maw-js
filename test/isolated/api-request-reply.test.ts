import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { requestReplyApi } from "../../src/api/request-reply";
import { requestReplyStore } from "../../src/core/request-reply";
import { agentStatusStore } from "../../src/core/agent-status";

describe("Request-Reply API", () => {
  let app: Elysia;

  beforeEach(() => {
    app = new Elysia().use(requestReplyApi);
    // Clear stores
    for (const e of agentStatusStore.getAll()) agentStatusStore.remove(e.oracle);
    for (const e of requestReplyStore.getAll()) {
      // No delete method — store will be recreated per test anyway
    }
  });

  test("POST /request creates request with correlationId", async () => {
    const res = await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "neo", message: "what is the matrix?" }),
    }));
    const body = await res.json() as { correlationId: string; status: string };
    expect(body.correlationId).toMatch(/^req-/);
    expect(body.status).toBe("delivered");
  });

  test("POST /request queues when target is busy", async () => {
    agentStatusStore.report("neo", "busy");
    const res = await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "neo", message: "urgent" }),
    }));
    const body = await res.json() as { correlationId: string; status: string };
    expect(body.status).toBe("queued");
  });

  test("GET /request/:correlationId returns request", async () => {
    // Create request first
    const createRes = await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "neo", message: "hello" }),
    }));
    const { correlationId } = await createRes.json() as { correlationId: string };

    const getRes = await app.handle(new Request(`http://localhost/request/${correlationId}`));
    const body = await getRes.json() as { correlationId: string; message: string };
    expect(body.correlationId).toBe(correlationId);
    expect(body.message).toBe("hello");
  });

  test("POST /reply/:correlationId stores reply", async () => {
    const createRes = await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "neo", message: "hello" }),
    }));
    const { correlationId } = await createRes.json() as { correlationId: string };

    const replyRes = await app.handle(new Request(`http://localhost/reply/${correlationId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "the matrix has you" }),
    }));
    const replyBody = await replyRes.json() as { ok: boolean };
    expect(replyBody.ok).toBe(true);

    // Poll for reply
    const pollRes = await app.handle(new Request(`http://localhost/request/${correlationId}`));
    const pollBody = await pollRes.json() as { status: string; reply: string };
    expect(pollBody.status).toBe("replied");
    expect(pollBody.reply).toBe("the matrix has you");
  });

  test("GET /requests lists all requests", async () => {
    await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "neo", message: "m1" }),
    }));
    await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "morpheus", message: "m2" }),
    }));

    const res = await app.handle(new Request("http://localhost/requests"));
    const body = await res.json() as { total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test("GET /requests?oracle=neo filters by oracle", async () => {
    await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "neo", message: "m1" }),
    }));
    await app.handle(new Request("http://localhost/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "morpheus", message: "m2" }),
    }));

    const res = await app.handle(new Request("http://localhost/requests?oracle=neo"));
    const body = await res.json() as { total: number; requests: { to: string }[] };
    expect(body.requests.every(r => r.to === "neo")).toBe(true);
  });
});
