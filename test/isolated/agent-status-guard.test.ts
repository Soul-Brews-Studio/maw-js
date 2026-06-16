import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { extractOracleName, checkBusyGuard } from "../../src/core/agent-status-guard";
import { agentStatusStore } from "../../src/core/agent-status";

const originalFetch = globalThis.fetch;

describe("extractOracleName", () => {
  test("bare name", () => {
    expect(extractOracleName("neo")).toBe("neo");
  });

  test("strips -oracle suffix", () => {
    expect(extractOracleName("neo-oracle")).toBe("neo");
  });

  test("session:window format", () => {
    expect(extractOracleName("08-mawjs:neo-oracle")).toBe("neo");
  });

  test("session:window without -oracle", () => {
    expect(extractOracleName("08-mawjs:neo")).toBe("neo");
  });

  test("local: prefix", () => {
    expect(extractOracleName("local:neo")).toBe("neo");
  });

  test("node:oracle format", () => {
    expect(extractOracleName("white:neo-oracle")).toBe("neo");
  });
});

describe("checkBusyGuard", () => {
  beforeEach(() => {
    for (const e of agentStatusStore.getAll()) agentStatusStore.remove(e.oracle);
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("unknown agent → not busy", async () => {
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("unknown");
  });

  test("busy agent → busy=true", async () => {
    agentStatusStore.report("neo", "busy");
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(true);
    expect(result.status).toBe("busy");
  });

  test("ready agent → not busy", async () => {
    agentStatusStore.report("neo", "ready");
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("ready");
  });

  test("idle agent → not busy", async () => {
    agentStatusStore.report("neo", "idle");
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("idle");
  });

  test("resolves oracle name from session:window-oracle format", async () => {
    agentStatusStore.report("neo", "busy");
    const result = await checkBusyGuard("08-mawjs:neo-oracle");
    expect(result.busy).toBe(true);
    expect(result.oracle).toBe("neo");
  });
});
