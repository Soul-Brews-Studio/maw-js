import { beforeEach, describe, expect, test } from "bun:test";
import {
  cmdWorkspaceAgents,
  cmdWorkspaceShare,
  cmdWorkspaceUnshare,
  type WorkspaceAgentsDeps,
} from "../src/commands/shared/workspace-agents";
import type { WorkspaceConfig } from "../src/commands/shared/workspace-store";

type Workspace = WorkspaceConfig;
type CurlResult = { ok: boolean; status?: number; data?: { error?: string; nodes?: Record<string, string[]> } | null };

let defaultWorkspaceId: string | null = null;
let workspaces = new Map<string, Workspace>();
let savedWorkspaces: Workspace[] = [];
let reportedNoWorkspace = 0;
let configNode: string | undefined;
let curlResult: CurlResult = { ok: true, data: null };
let curlCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
let timeoutCalls: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let exitCode: number | undefined;

function workspace(id: string, sharedAgents: string[] = []): Workspace {
  return {
    id,
    name: `name-${id}`,
    hubUrl: `https://${id}.example`,
    sharedAgents,
    joinedAt: "2026-05-17T00:00:00.000Z",
  };
}

function deps(): WorkspaceAgentsDeps {
  return {
    resolveWorkspaceId: (explicit?: string) => explicit ?? defaultWorkspaceId,
    reportNoWorkspaceId: () => {
      reportedNoWorkspace += 1;
      errors.push("no workspaces joined");
    },
    loadWorkspace: (id: string) => {
      const ws = workspaces.get(id);
      return ws ? { ...ws, sharedAgents: [...ws.sharedAgents] } : null;
    },
    saveWorkspace: (ws: Workspace) => {
      const saved = { ...ws, sharedAgents: [...ws.sharedAgents] };
      savedWorkspaces.push(saved);
      workspaces.set(ws.id, saved);
    },
    loadConfig: () => (configNode === undefined ? {} : { node: configNode }),
    cfgTimeout: (scope: string) => {
      timeoutCalls.push(scope);
      return 1234;
    },
    curlFetch: async (url: string, opts?: Record<string, unknown>) => {
      curlCalls.push({ url, opts: opts ?? {} });
      return curlResult as Awaited<ReturnType<NonNullable<WorkspaceAgentsDeps["curlFetch"]>>>;
    },
    log: {
      log: (...args: unknown[]) => logs.push(args.join(" ")),
      error: (...args: unknown[]) => errors.push(args.join(" ")),
    },
    exit: (code?: number): never => {
      exitCode = code ?? 0;
      throw new Error(`__exit__:${exitCode}`);
    },
  };
}

function output(): string {
  return [...logs, ...errors].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__")) throw error;
  }
}

describe("workspace agents command default-suite seams", () => {
  beforeEach(() => {
    defaultWorkspaceId = null;
    workspaces = new Map();
    savedWorkspaces = [];
    reportedNoWorkspace = 0;
    configNode = undefined;
    curlResult = { ok: true, data: null };
    curlCalls = [];
    timeoutCalls = [];
    logs = [];
    errors = [];
    exitCode = undefined;
  });

  test("share reports missing workspace context and missing explicit workspaces", async () => {
    await run(() => cmdWorkspaceShare(["alice"], undefined, deps()));
    expect(exitCode).toBe(1);
    expect(reportedNoWorkspace).toBe(1);
    expect(curlCalls).toEqual([]);

    exitCode = undefined;
    await run(() => cmdWorkspaceShare(["alice"], "ghost", deps()));
    expect(exitCode).toBe(1);
    expect(output()).toContain("workspace not found: ghost");
  });

  test("share posts agents, dedupes local state, saves, and prints totals", async () => {
    const ws = workspace("ws-share", ["alice"]);
    workspaces.set(ws.id, ws);
    configNode = "m5";

    await run(() => cmdWorkspaceShare(["alice", "bob"], ws.id, deps()));

    expect(exitCode).toBeUndefined();
    expect(curlCalls).toEqual([{ url: "https://ws-share.example/api/workspace/ws-share/agents", opts: {
      method: "POST",
      body: JSON.stringify({ action: "share", agents: ["alice", "bob"], node: "m5" }),
    } }]);
    expect(savedWorkspaces).toHaveLength(1);
    expect(savedWorkspaces[0].sharedAgents.sort()).toEqual(["alice", "bob"]);
    expect(output()).toContain("shared 2 agent(s)");
    expect(output()).toContain("+ bob");
    expect(output()).toContain("total shared: 2");
  });

  test("share exits on hub errors before mutating local state", async () => {
    const ws = workspace("ws-share-fail", ["eve"]);
    workspaces.set(ws.id, ws);
    curlResult = { ok: false, status: 502, data: { error: "hub rejected" } };

    await run(() => cmdWorkspaceShare(["mallory"], ws.id, deps()));

    expect(exitCode).toBe(1);
    expect(savedWorkspaces).toEqual([]);
    expect(workspaces.get(ws.id)?.sharedAgents).toEqual(["eve"]);
    expect(output()).toContain("failed to share agents: hub rejected");
  });

  test("unshare reports missing workspace context and missing explicit workspaces", async () => {
    await run(() => cmdWorkspaceUnshare(["alice"], undefined, deps()));
    expect(exitCode).toBe(1);
    expect(reportedNoWorkspace).toBe(1);

    exitCode = undefined;
    await run(() => cmdWorkspaceUnshare(["alice"], "ghost", deps()));
    expect(exitCode).toBe(1);
    expect(output()).toContain("workspace not found: ghost");
  });

  test("unshare posts removals, filters local state, and falls back to local node", async () => {
    const ws = workspace("ws-unshare", ["alice", "bob", "carol"]);
    workspaces.set(ws.id, ws);

    await run(() => cmdWorkspaceUnshare(["bob"], ws.id, deps()));

    const body = JSON.parse(String(curlCalls[0].opts.body));
    expect(body).toEqual({ action: "unshare", agents: ["bob"], node: "local" });
    expect(savedWorkspaces[0].sharedAgents).toEqual(["alice", "carol"]);
    expect(output()).toContain("removed 1 agent(s)");
    expect(output()).toContain("- bob");
    expect(output()).toContain("total shared: 2");
  });

  test("unshare exits on hub errors before saving", async () => {
    const ws = workspace("ws-unshare-fail", ["alice"]);
    workspaces.set(ws.id, ws);
    curlResult = { ok: false, status: 500, data: null };

    await run(() => cmdWorkspaceUnshare(["alice"], ws.id, deps()));

    expect(exitCode).toBe(1);
    expect(savedWorkspaces).toEqual([]);
    expect(output()).toContain("failed to unshare agents: HTTP 500");
  });

  test("agents reports missing workspace context and missing explicit workspaces", async () => {
    await run(() => cmdWorkspaceAgents(undefined, deps()));
    expect(exitCode).toBe(1);
    expect(reportedNoWorkspace).toBe(1);

    exitCode = undefined;
    await run(() => cmdWorkspaceAgents("ghost", deps()));
    expect(exitCode).toBe(1);
    expect(output()).toContain("workspace not found: ghost");
  });

  test("agents treats missing node data as empty and shows the share hint", async () => {
    const ws = workspace("ws-empty");
    workspaces.set(ws.id, ws);
    curlResult = { ok: true, data: {} };

    await run(() => cmdWorkspaceAgents(ws.id, deps()));

    expect(timeoutCalls).toEqual(["workspace"]);
    expect(curlCalls).toEqual([{ url: "https://ws-empty.example/api/workspace/ws-empty/agents", opts: { timeout: 1234 } }]);
    expect(output()).toContain("No agents in workspace yet");
    expect(output()).toContain("maw workspace share <agent...>");
  });

  test("agents renders grouped nodes with singular and plural counts", async () => {
    const ws = workspace("ws-agents");
    workspaces.set(ws.id, ws);
    curlResult = { ok: true, data: { nodes: { m5: ["alice", "bob"], mba: ["carol"], empty: [] } } };

    await run(() => cmdWorkspaceAgents(ws.id, deps()));

    expect(output()).toContain("name-ws-agents  Agents by node");
    expect(output()).toContain("m5  (2 agents)");
    expect(output()).toContain("mba  (1 agent)");
    expect(output()).toContain("empty  (0 agents)");
    expect(output()).toContain("alice");
    expect(output()).toContain("3 total agents across 3 nodes");
  });

  test("agents exits on hub errors", async () => {
    const ws = workspace("ws-agents-fail");
    workspaces.set(ws.id, ws);
    curlResult = { ok: false, status: 503, data: { error: "hub down" } };

    await run(() => cmdWorkspaceAgents(ws.id, deps()));

    expect(exitCode).toBe(1);
    expect(output()).toContain("failed to fetch agents: hub down");
  });
});
