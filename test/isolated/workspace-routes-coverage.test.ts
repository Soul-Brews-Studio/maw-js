import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type WorkspaceLike = {
  id: string;
  name: string;
  token: string;
  joinCode: string;
  joinCodeExpiresAt: number;
  createdAt: string;
  creatorNodeId: string;
  nodes: Array<{ nodeId: string; joinedAt: string; lastSeen: string }>;
  agents: Array<{ name: string; nodeId: string; status: string; capabilities: string[]; updatedAt: string }>;
  feed: Array<{ nodeId: string; type: string; message: string; ts: number }>;
};

const workspaces = new Map<string, WorkspaceLike>();
let loadAllCalls = 0;
let persistCalls: string[] = [];
let authCalls: Array<{ id: string; method: string; path: string; headers: { sig?: string; ts?: string } }> = [];
let authResult: WorkspaceLike | null = null;
let generateWorkspaceIdValue = "ws-1";
let generateTokenValue = "tok-1";
let generateJoinCodeValue = "JOIN-123";
let touchNodeCalls: Array<{ workspaceId: string; nodeId: string }> = [];
let pushFeedCalls: Array<{ workspaceId: string; type: string; message: string; nodeId: string }> = [];

const realDateNow = Date.now;

function makeWorkspace(overrides: Partial<WorkspaceLike> = {}): WorkspaceLike {
  return {
    id: "ws-1",
    name: "alpha",
    token: "tok-1",
    joinCode: "JOIN-123",
    joinCodeExpiresAt: 2_000_000_000_000,
    createdAt: "2026-05-18T00:00:00.000Z",
    creatorNodeId: "m5",
    nodes: [{ nodeId: "m5", joinedAt: "2026-05-18T00:00:00.000Z", lastSeen: "2026-05-18T00:04:30.000Z" }],
    agents: [],
    feed: [],
    ...overrides,
  };
}

mock.module("../../src/api/workspace-storage", () => ({
  loadAll: () => { loadAllCalls++; },
  workspaces,
  persist: (ws: WorkspaceLike) => { persistCalls.push(ws.id); },
  findByJoinCode: (code: string) => {
    for (const ws of workspaces.values()) {
      if (ws.joinCode === code && ws.joinCodeExpiresAt > Date.now()) return ws;
    }
    return undefined;
  },
}));

mock.module("../../src/api/workspace-auth", () => ({
  authenticateWorkspace: (id: string, method: string, path: string, headers: { sig?: string; ts?: string }) => {
    authCalls.push({ id, method, path, headers });
    return authResult;
  },
}));

mock.module("../../src/api/workspace-helpers", () => ({
  generateWorkspaceId: () => generateWorkspaceIdValue,
  generateToken: () => generateTokenValue,
  generateJoinCode: () => generateJoinCodeValue,
  touchNode: (ws: WorkspaceLike, nodeId: string) => {
    touchNodeCalls.push({ workspaceId: ws.id, nodeId });
    const node = ws.nodes.find(entry => entry.nodeId === nodeId);
    if (node) node.lastSeen = "2026-05-18T00:05:00.000Z";
  },
  pushFeed: (ws: WorkspaceLike, event: { nodeId: string; type: string; message: string; ts: number }) => {
    pushFeedCalls.push({ workspaceId: ws.id, type: event.type, message: event.message, nodeId: event.nodeId });
    ws.feed.push(event);
  },
}));

const { workspaceApi } = await import("../../src/api/workspace-routes.ts?workspace-routes-coverage");

async function json(res: Response): Promise<any> {
  return await res.json();
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://local${path}`, init);
}

describe("workspace routes isolated coverage", () => {
  beforeEach(() => {
    workspaces.clear();
    loadAllCalls = 0;
    persistCalls = [];
    authCalls = [];
    authResult = null;
    generateWorkspaceIdValue = "ws-1";
    generateTokenValue = "tok-1";
    generateJoinCodeValue = "JOIN-123";
    touchNodeCalls = [];
    pushFeedCalls = [];
    Date.now = () => Date.parse("2026-05-18T00:05:00.000Z");
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  test("create validates input and persists the created workspace plus feed", async () => {
    let res = await workspaceApi.handle(req("/workspace/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", nodeId: "m5" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "name and nodeId are required" });

    res = await workspaceApi.handle(req("/workspace/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha", nodeId: "m5" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      id: "ws-1",
      token: "tok-1",
      joinCode: "JOIN-123",
      joinCodeExpiresAt: Date.parse("2026-05-19T00:05:00.000Z"),
    });
    expect(loadAllCalls).toBe(2);
    expect(persistCalls).toEqual(["ws-1", "ws-1"]);
    expect(pushFeedCalls).toEqual([
      {
        workspaceId: "ws-1",
        nodeId: "m5",
        type: "workspace.created",
        message: 'Workspace "alpha" created',
      },
    ]);
    expect(workspaces.get("ws-1")).toMatchObject({
      id: "ws-1",
      name: "alpha",
      token: "tok-1",
      joinCode: "JOIN-123",
      creatorNodeId: "m5",
      agents: [],
      nodes: [{ nodeId: "m5" }],
    });
    expect(workspaces.get("ws-1")?.feed).toHaveLength(1);
  });

  test("join validates input, rejects invalid codes, and only records a new node once", async () => {
    const ws = makeWorkspace();
    workspaces.set(ws.id, ws);

    let res = await workspaceApi.handle(req("/workspace/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "", nodeId: "white" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "code and nodeId are required" });

    res = await workspaceApi.handle(req("/workspace/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "miss", nodeId: "white" }),
    }));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "invalid or expired join code" });

    res = await workspaceApi.handle(req("/workspace/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "join-123", nodeId: "white" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ workspaceId: "ws-1", token: "tok-1", name: "alpha" });
    expect(ws.nodes.map(node => node.nodeId)).toEqual(["m5", "white"]);
    expect(pushFeedCalls.at(-1)).toEqual({
      workspaceId: "ws-1",
      nodeId: "white",
      type: "node.joined",
      message: 'Node "white" joined',
    });

    const feedCount = ws.feed.length;
    res = await workspaceApi.handle(req("/workspace/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "JOIN-123", nodeId: "white" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ workspaceId: "ws-1", token: "tok-1", name: "alpha" });
    expect(ws.nodes.map(node => node.nodeId)).toEqual(["m5", "white"]);
    expect(ws.feed).toHaveLength(feedCount);
  });

  test("agents route authenticates, validates input, registers, and updates existing agents", async () => {
    const ws = makeWorkspace();
    workspaces.set(ws.id, ws);

    let res = await workspaceApi.handle(req("/workspace/ws-1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-signature": "sig-1", "x-maw-timestamp": "ts-1" },
      body: JSON.stringify({ name: "neo", nodeId: "white" }),
    }));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "workspace auth failed" });

    authResult = ws;
    res = await workspaceApi.handle(req("/workspace/ws-1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-signature": "sig-2", "x-maw-timestamp": "ts-2" },
      body: JSON.stringify({ name: "", nodeId: "white" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "name and nodeId are required" });

    res = await workspaceApi.handle(req("/workspace/ws-1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-signature": "sig-3", "x-maw-timestamp": "ts-3" },
      body: JSON.stringify({ name: "neo", nodeId: "white", status: "ready", capabilities: ["ship", "test"] }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, agents: 1 });
    expect(ws.agents).toHaveLength(1);
    expect(ws.agents[0]).toMatchObject({
      name: "neo",
      nodeId: "white",
      status: "ready",
      capabilities: ["ship", "test"],
    });
    expect(typeof ws.agents[0]?.updatedAt).toBe("string");
    expect(pushFeedCalls.at(-1)).toEqual({
      workspaceId: "ws-1",
      nodeId: "white",
      type: "agent.registered",
      message: 'Agent "neo" registered from white',
    });
    expect(touchNodeCalls).toEqual([{ workspaceId: "ws-1", nodeId: "white" }]);

    res = await workspaceApi.handle(req("/workspace/ws-1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-signature": "sig-4", "x-maw-timestamp": "ts-4" },
      body: JSON.stringify({ name: "neo", nodeId: "white", status: "busy" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, agents: 1 });
    expect(ws.agents[0]).toMatchObject({
      name: "neo",
      nodeId: "white",
      status: "busy",
      capabilities: ["ship", "test"],
    });
    expect(typeof ws.agents[0]?.updatedAt).toBe("string");
    expect(authCalls.map(call => ({ id: call.id, method: call.method, path: call.path }))).toContainEqual({
      id: "ws-1",
      method: "POST",
      path: "/workspace/ws-1/agents",
    });
  });

  test("read routes return agents, status health, and reverse-ordered feed slices", async () => {
    const ws = makeWorkspace({
      nodes: [
        { nodeId: "m5", joinedAt: "2026-05-18T00:00:00.000Z", lastSeen: "2026-05-18T00:04:59.000Z" },
        { nodeId: "white", joinedAt: "2026-05-18T00:01:00.000Z", lastSeen: "2026-05-17T23:50:00.000Z" },
      ],
      agents: [
        { name: "neo", nodeId: "m5", status: "ready", capabilities: [], updatedAt: "2026-05-18T00:02:00.000Z" },
        { name: "trinity", nodeId: "white", status: "busy", capabilities: ["ship"], updatedAt: "2026-05-18T00:03:00.000Z" },
      ],
      feed: [
        { nodeId: "m5", type: "workspace.created", message: "created", ts: 1 },
        { nodeId: "white", type: "node.joined", message: "joined", ts: 2 },
        { nodeId: "neo", type: "message", message: "hello", ts: 3 },
      ],
    });
    authResult = ws;

    let res = await workspaceApi.handle(req("/workspace/ws-1/agents", {
      headers: { "x-maw-signature": "sig", "x-maw-timestamp": "ts" },
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ agents: ws.agents, total: 2 });

    res = await workspaceApi.handle(req("/workspace/ws-1/status", {
      headers: { "x-maw-signature": "sig", "x-maw-timestamp": "ts" },
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      id: "ws-1",
      name: "alpha",
      createdAt: "2026-05-18T00:00:00.000Z",
      nodes: ws.nodes,
      nodeCount: 2,
      healthyNodeCount: 1,
      agentCount: 2,
      feedCount: 3,
    });

    res = await workspaceApi.handle(req("/workspace/ws-1/feed?limit=2", {
      headers: { "x-maw-signature": "sig", "x-maw-timestamp": "ts" },
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      events: [
        { nodeId: "neo", type: "message", message: "hello", ts: 3 },
        { nodeId: "white", type: "node.joined", message: "joined", ts: 2 },
      ],
      total: 2,
    });
  });

  test("message route validates input, appends feed, and persists", async () => {
    const ws = makeWorkspace();
    authResult = ws;

    let res = await workspaceApi.handle(req("/workspace/ws-1/message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-signature": "sig", "x-maw-timestamp": "ts" },
      body: JSON.stringify({ from: "", text: "" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "from and text are required" });

    res = await workspaceApi.handle(req("/workspace/ws-1/message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maw-signature": "sig", "x-maw-timestamp": "ts" },
      body: JSON.stringify({ from: "neo", to: "trinity", text: "ship it" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(pushFeedCalls.at(-1)).toEqual({
      workspaceId: "ws-1",
      nodeId: "neo",
      type: "message",
      message: "[neo -> trinity] ship it",
    });
    expect(persistCalls.at(-1)).toBe("ws-1");
    expect(ws.feed.at(-1)).toMatchObject({ type: "message", message: "[neo -> trinity] ship it" });
  });
});
