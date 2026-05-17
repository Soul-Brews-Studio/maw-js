import { beforeEach, describe, expect, test } from "bun:test";
import {
  cmdWorkspaceInvite,
  cmdWorkspaceLs,
  cmdWorkspaceStatus,
  type WorkspaceQueryDeps,
} from "../src/commands/shared/workspace-query";
import type { WorkspaceConfig } from "../src/commands/shared/workspace-store";

type Workspace = WorkspaceConfig;
type CurlData = {
  error?: string;
  joinCode?: string;
  expiry?: string;
  agentCount?: number;
  nodeCount?: number;
} | null;
type CurlResult = { ok: boolean; status?: number; data?: CurlData };
type CurlStub = { match: RegExp; response?: CurlResult; error?: string };

let defaultWorkspaceId: string | null = null;
let workspaces = new Map<string, Workspace>();
let savedWorkspaces: Workspace[] = [];
let curlStubs: CurlStub[] = [];
let curlCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
let timeoutCalls: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let exitCode: number | undefined;
let clock = 1_000;
let reportedNoWorkspace = 0;

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `name-${id}`,
    hubUrl: `https://${id}.example`,
    sharedAgents: [],
    joinedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

function cloneWorkspace(ws: Workspace): Workspace {
  return { ...ws, sharedAgents: [...ws.sharedAgents] };
}

function deps(): WorkspaceQueryDeps {
  return {
    resolveWorkspaceId: (explicit?: string) => explicit ?? defaultWorkspaceId,
    reportNoWorkspaceId: () => {
      reportedNoWorkspace += 1;
      errors.push("no workspaces joined");
    },
    loadWorkspace: (id: string) => {
      const ws = workspaces.get(id);
      return ws ? cloneWorkspace(ws) : null;
    },
    loadAllWorkspaces: () => [...workspaces.values()].map(cloneWorkspace),
    saveWorkspace: (ws: Workspace) => {
      const saved = cloneWorkspace(ws);
      savedWorkspaces.push(saved);
      workspaces.set(ws.id, saved);
    },
    cfgTimeout: (scope: string) => {
      timeoutCalls.push(scope);
      return 1234;
    },
    curlFetch: async (url: string, opts?: Record<string, unknown>) => {
      curlCalls.push({ url, opts: opts ?? {} });
      const stub = curlStubs.find((entry) => entry.match.test(url));
      if (stub?.error) throw new Error(stub.error);
      return (stub?.response ?? { ok: true, data: null }) as Awaited<ReturnType<NonNullable<WorkspaceQueryDeps["curlFetch"]>>>;
    },
    log: {
      log: (...args: unknown[]) => logs.push(args.join(" ")),
      error: (...args: unknown[]) => errors.push(args.join(" ")),
    },
    exit: (code?: number): never => {
      exitCode = code ?? 0;
      throw new Error(`__exit__:${exitCode}`);
    },
    now: () => {
      clock += 7;
      return clock;
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

describe("workspace query command default-suite seams", () => {
  beforeEach(() => {
    defaultWorkspaceId = null;
    workspaces = new Map();
    savedWorkspaces = [];
    curlStubs = [];
    curlCalls = [];
    timeoutCalls = [];
    logs = [];
    errors = [];
    exitCode = undefined;
    clock = 1_000;
    reportedNoWorkspace = 0;
  });

  test("ls renders onboarding hints when no workspaces are configured", async () => {
    await run(() => cmdWorkspaceLs(deps()));

    expect(output()).toContain("No workspaces configured");
    expect(output()).toContain("maw workspace create <name>");
    expect(output()).toContain("maw workspace join <code>");
  });

  test("ls renders connected, disconnected, shared, empty, plural, and singular workspace rows", async () => {
    workspaces.set("ws-one", workspace("ws-one", {
      name: "one",
      hubUrl: "https://one.example",
      sharedAgents: ["alice", "bob"],
      joinedAt: "2026-05-01",
      lastStatus: "connected",
    }));
    workspaces.set("ws-two", workspace("ws-two", {
      name: "two",
      hubUrl: "https://two.example",
      joinedAt: "2026-05-02",
      lastStatus: "disconnected",
    }));
    workspaces.set("ws-solo", workspace("ws-solo", {
      name: "solo",
      sharedAgents: ["carol"],
      joinedAt: "2026-05-03",
    }));

    await run(() => cmdWorkspaceLs(deps()));

    const text = output();
    expect(text).toContain("Workspaces");
    expect(text).toContain("3 joined");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("solo");
    expect(text).toContain("alice, bob");
    expect(text).toContain("no agents shared");
    expect(text).toContain("1 agent shared");
    expect(logs.join("\n")).toContain("\x1b[32m●\x1b[0m");
    expect(logs.join("\n")).toContain("\x1b[31m●\x1b[0m");
  });

  test("invite reports missing workspace context and missing explicit workspaces", async () => {
    await run(() => cmdWorkspaceInvite(undefined, deps()));
    expect(exitCode).toBe(1);
    expect(reportedNoWorkspace).toBe(1);

    exitCode = undefined;
    await run(() => cmdWorkspaceInvite("ghost", deps()));
    expect(exitCode).toBe(1);
    expect(output()).toContain("workspace not found: ghost");
  });

  test("invite fetches status, prints server join code with expiry, and uses workspace timeout", async () => {
    workspaces.set("ws-invite", workspace("ws-invite", { name: "invite" }));
    curlStubs = [{
      match: /status/,
      response: { ok: true, data: { joinCode: "CODE-111", expiry: "2026-05-17T12:00:00Z" } },
    }];

    await run(() => cmdWorkspaceInvite("ws-invite", deps()));

    expect(exitCode).toBeUndefined();
    expect(timeoutCalls).toEqual(["workspace"]);
    expect(curlCalls).toEqual([{ url: "https://ws-invite.example/api/workspace/ws-invite/status", opts: { timeout: 1234 } }]);
    expect(output()).toContain("invite  Invite");
    expect(output()).toContain("CODE-111");
    expect(output()).toContain("Expires:");
    expect(output()).toContain("maw workspace join CODE-111 --hub https://ws-invite.example");
  });

  test("invite falls back to local join code and omits expiry when the hub omits both", async () => {
    workspaces.set("ws-local-code", workspace("ws-local-code", { joinCode: "LOCAL-CODE" }));
    curlStubs = [{ match: /status/, response: { ok: true, data: {} } }];

    await run(() => cmdWorkspaceInvite("ws-local-code", deps()));

    expect(output()).toContain("LOCAL-CODE");
    expect(output()).not.toContain("Expires:");
  });

  test("invite exits on hub errors and missing join codes", async () => {
    workspaces.set("ws-fail", workspace("ws-fail"));
    curlStubs = [{ match: /status/, response: { ok: false, status: 502, data: { error: "hub down" } } }];

    await run(() => cmdWorkspaceInvite("ws-fail", deps()));
    expect(exitCode).toBe(1);
    expect(output()).toContain("failed to fetch invite info: hub down");

    exitCode = undefined;
    errors = [];
    curlStubs = [{ match: /status/, response: { ok: true, data: {} } }];
    await run(() => cmdWorkspaceInvite("ws-fail", deps()));
    expect(exitCode).toBe(1);
    expect(output()).toContain("no join code available");
  });

  test("status renders empty workspace state without network calls", async () => {
    await run(() => cmdWorkspaceStatus(deps()));

    expect(output()).toContain("No workspaces configured");
    expect(curlCalls).toEqual([]);
  });

  test("status updates connected workspaces and renders singular agent/node counts", async () => {
    workspaces.set("ws-up", workspace("ws-up", { name: "up", hubUrl: "https://up.example" }));
    curlStubs = [{ match: /up\.example/, response: { ok: true, data: { agentCount: 1, nodeCount: 1 } } }];

    await run(() => cmdWorkspaceStatus(deps()));

    expect(savedWorkspaces).toHaveLength(1);
    expect(savedWorkspaces[0].lastStatus).toBe("connected");
    expect(workspaces.get("ws-up")?.lastStatus).toBe("connected");
    expect(output()).toContain("Workspace Status");
    expect(output()).toContain("up");
    expect(output()).toMatch(/1 agent\b/);
    expect(output()).toMatch(/1 node\b/);
    expect(output()).toContain("1/1 connected");
  });

  test("status marks non-ok and throwing workspaces disconnected while preserving total counts", async () => {
    workspaces.set("ws-up", workspace("ws-up", { hubUrl: "https://up.example" }));
    workspaces.set("ws-down", workspace("ws-down", { hubUrl: "https://down.example" }));
    workspaces.set("ws-boom", workspace("ws-boom", { hubUrl: "https://boom.example" }));
    curlStubs = [
      { match: /up\.example/, response: { ok: true, data: { agentCount: 3, nodeCount: 2 } } },
      { match: /down\.example/, response: { ok: false, status: 500, data: null } },
      { match: /boom\.example/, error: "network down" },
    ];

    await run(() => cmdWorkspaceStatus(deps()));

    expect(savedWorkspaces.map((ws) => [ws.id, ws.lastStatus])).toEqual([
      ["ws-up", "connected"],
      ["ws-down", "disconnected"],
      ["ws-boom", "disconnected"],
    ]);
    expect(output()).toContain("3 agents");
    expect(output()).toContain("2 nodes");
    expect(output()).toContain("disconnected");
    expect(output()).toContain("1/3 connected");
    expect(timeoutCalls).toEqual(["workspace", "workspace", "workspace"]);
  });
});
