/**
 * Tests for #1132 — /api/agents and /api/agent endpoints.
 *
 * Verifies the new agents API surfaces the same data as `maw agents --json`,
 * including the `?all=1` query param and the alias path /api/agent.
 *
 * Mocks tmux + config modules so the test is hermetic.
 */
import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

// Mock tmux SDK before importing the API module
mock.module("../src/sdk", () => ({
  tmux: {
    listAll: async () => [
      { name: "01-mawjs", windows: [{ index: "0", name: "mawjs-oracle" }] },
      { name: "02-neo", windows: [{ index: "0", name: "neo-oracle" }, { index: "1", name: "shell" }] },
    ],
    listPanes: async () => [
      { command: "claude", target: "01-mawjs:0.0", pid: 1001 },
      { command: "claude", target: "02-neo:0.0", pid: 1002 },
      { command: "zsh", target: "02-neo:1.0", pid: 1003 },
    ],
  },
}));

mock.module("../src/config", () => ({
  loadConfig: () => ({ node: "test-node", commands: { default: "claude" } }),
}));

const { agentsApi } = await import("../src/api/agents");
const app = new Elysia({ prefix: "/api" }).use(agentsApi);

async function hit(path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

describe("/api/agents (#1132)", () => {
  test("returns oracle-only rows by default", async () => {
    const res = await hit("/api/agents");
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.count).toBe(2);
    expect(body.node).toBe("test-node");
    expect(body.agents).toHaveLength(2);
    expect(body.agents.map((a: any) => a.oracle).sort()).toEqual(["mawjs", "neo"]);
    expect(body.agents.every((a: any) => a.window.endsWith("-oracle"))).toBe(true);
  });

  test("?all=1 includes non-oracle panes", async () => {
    const res = await hit("/api/agents?all=1");
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.count).toBe(3);
    expect(body.agents.find((a: any) => a.window === "shell")).toBeDefined();
  });

  test("?all=true also enables", async () => {
    const res = await hit("/api/agents?all=true");
    const body: any = await res.json();
    expect(body.count).toBe(3);
  });

  test("/api/agent (singular alias) returns same data", async () => {
    const res = await hit("/api/agent");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.count).toBe(2);
    expect(body.agents.map((a: any) => a.oracle).sort()).toEqual(["mawjs", "neo"]);
  });

  test("agent row shape matches CLI format", async () => {
    const res = await hit("/api/agents");
    const body: any = await res.json();
    const row = body.agents[0];

    expect(row).toHaveProperty("node");
    expect(row).toHaveProperty("session");
    expect(row).toHaveProperty("window");
    expect(row).toHaveProperty("oracle");
    expect(row).toHaveProperty("state");
    expect(row).toHaveProperty("pid");
  });
});
