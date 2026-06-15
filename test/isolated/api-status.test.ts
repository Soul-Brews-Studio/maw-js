import { describe, test, expect, beforeEach } from "bun:test";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";
import { registerServeHealthRoutes } from "../../src/vendor-plugins/serve-config-health/index";
import { agentStatusStore } from "../../src/core/agent-status";

describe("Status API", () => {
  let app: ServeRouteRegistry;

  beforeEach(() => {
    app = new ServeRouteRegistry();
    registerServeHealthRoutes(app);
    // Clear store between tests — access internal map via report/remove
    for (const e of agentStatusStore.getAll()) agentStatusStore.remove(e.oracle);
  });

  test("GET /status returns empty list initially", async () => {
    const res = await app.handle(new Request("http://localhost/api/status"));
    const body = await res.json() as { agents: unknown[]; summary: Record<string, number>; total: number };
    expect(body.agents).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("POST /status reports agent status", async () => {
    const res = await app.handle(new Request("http://localhost/api/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oracle: "neo", status: "busy", sessionId: "s1" }),
    }));
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const getRes = await app.handle(new Request("http://localhost/api/status/neo"));
    const entry = await getRes.json() as { oracle: string; status: string };
    expect(entry.oracle).toBe("neo");
    expect(entry.status).toBe("busy");
  });

  test("POST /status rejects invalid status", async () => {
    const res = await app.handle(new Request("http://localhost/api/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oracle: "neo", status: "invalid" }),
    }));
    const body = await res.json() as { error: string };
    expect(body.error).toContain("invalid status");
  });

  test("GET /status/:oracle returns 'not found' for unknown", async () => {
    const res = await app.handle(new Request("http://localhost/api/status/unknown"));
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not found");
  });

  test("GET /status returns summary counts", async () => {
    agentStatusStore.report("neo", "busy");
    agentStatusStore.report("morpheus", "busy");
    agentStatusStore.report("trinity", "ready");

    const res = await app.handle(new Request("http://localhost/api/status"));
    const body = await res.json() as { summary: Record<string, number>; total: number };
    expect(body.summary.busy).toBe(2);
    expect(body.summary.ready).toBe(1);
    expect(body.total).toBe(3);
  });
});
