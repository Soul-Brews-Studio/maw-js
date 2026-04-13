/**
 * Workspace Hub API — multi-node workspace management.
 *
 * Runs on a public VPS alongside maw-js. Provides:
 *   - Workspace creation with join codes
 *   - Shared agent registry across nodes
 *   - Feed events and messaging (REST fallback)
 *
 * Auth: HMAC-SHA256 with workspace token (same pattern as federation-auth).
 * Storage: JSON files in ~/.config/maw/workspaces/
 */

import { Elysia, t} from "elysia";
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../paths";

// --- Types ---

export interface WorkspaceAgent {
  name: string;
  nodeId: string;
  status?: string;
  capabilities?: string[];
  updatedAt: string;
}

export interface WorkspaceFeedEvent {
  id: string;
  nodeId: string;
  type: string;
  message: string;
  ts: number;
}

export interface WorkspaceNode {
  nodeId: string;
  joinedAt: string;
  lastSeen: string;
}

export interface Workspace {
  id: string;
  name: string;
  token: string;
  joinCode: string;
  joinCodeExpiresAt: number;
  createdAt: string;
  creatorNodeId: string;
  nodes: WorkspaceNode[];
  agents: WorkspaceAgent[];
  feed: WorkspaceFeedEvent[];
}

// --- Storage ---

export const WORKSPACE_DIR = join(CONFIG_DIR, "workspaces");
mkdirSync(WORKSPACE_DIR, { recursive: true });

/** In-memory cache, persisted to disk on mutation */
const workspaces = new Map<string, Workspace>();

/** Load all workspaces from disk into memory */
function loadAll() {
  if (workspaces.size > 0) return; // already loaded
  try {
    for (const file of readdirSync(WORKSPACE_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ws = JSON.parse(readFileSync(join(WORKSPACE_DIR, file), "utf-8")) as Workspace;
        workspaces.set(ws.id, ws);
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir doesn't exist yet */ }
}

function persist(ws: Workspace) {
  writeFileSync(join(WORKSPACE_DIR, `${ws.id}.json`), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}

/** Find workspace by join code (linear scan — small N) */
function findByJoinCode(code: string): Workspace | undefined {
  for (const ws of workspaces.values()) {
    if (ws.joinCode === code && ws.joinCodeExpiresAt > Date.now()) return ws;
  }
  return undefined;
}

// --- ID / Token Generation ---

function generateWorkspaceId(): string {
  return `ws_${randomUUID().slice(0, 8)}`;
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function generateJoinCode(): string {
  return randomBytes(4).toString("base64url").slice(0, 6).toUpperCase();
}

// --- HMAC Auth (workspace-scoped) ---

const WINDOW_SEC = 300; // +/-5 min

function wsSign(token: string, method: string, path: string, timestamp: number): string {
  return createHmac("sha256", token).update(`${method}:${path}:${timestamp}`).digest("hex");
}

function wsVerify(token: string, method: string, path: string, timestamp: number, signature: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > WINDOW_SEC) return false;
  const expected = wsSign(token, method, path, timestamp);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** Verify workspace HMAC from request headers. Returns workspace or null. */
function authenticateWorkspace(workspaceId: string, method: string, path: string, headers: { sig?: string; ts?: string }): Workspace | null {
  const ws = workspaces.get(workspaceId);
  if (!ws) return null;
  if (!headers.sig || !headers.ts) return null;
  const timestamp = parseInt(headers.ts, 10);
  if (isNaN(timestamp)) return null;
  if (!wsVerify(ws.token, method, path, timestamp, headers.sig)) return null;
  return ws;
}

/** Touch a node's lastSeen timestamp */
function touchNode(ws: Workspace, nodeId: string) {
  const node = ws.nodes.find(n => n.nodeId === nodeId);
  if (node) node.lastSeen = new Date().toISOString();
}

// --- Feed ---

const FEED_MAX = 200;

function pushFeed(ws: Workspace, event: Omit<WorkspaceFeedEvent, "id">) {
  const full: WorkspaceFeedEvent = { ...event, id: randomUUID().slice(0, 8) };
  ws.feed.push(full);
  if (ws.feed.length > FEED_MAX) ws.feed.splice(0, ws.feed.length - FEED_MAX);
}

// --- Router ---

export const workspaceApi = new Elysia()
  // Ensure workspaces are loaded on first request
  .onBeforeHandle(() => { loadAll(); });

/**
 * POST /workspace/create
 * Body: { name, nodeId }
 * Returns: { id, token, joinCode, joinCodeExpiresAt }
 */
workspaceApi.post("/workspace/create", async ({ body, set}) => {
  if (!body.name || !body.nodeId) {
    set.status = 400; return { error: "name and nodeId are required" };
  }

  const id = generateWorkspaceId();
  const token = generateToken();
  const joinCode = generateJoinCode();
  const now = new Date().toISOString();
  const joinCodeExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h

  const ws: Workspace = {
    id,
    name: body.name,
    token,
    joinCode,
    joinCodeExpiresAt,
    createdAt: now,
    creatorNodeId: body.nodeId,
    nodes: [{ nodeId: body.nodeId, joinedAt: now, lastSeen: now }],
    agents: [],
    feed: [],
  };

  workspaces.set(id, ws);
  persist(ws);

  pushFeed(ws, { nodeId: body.nodeId, type: "workspace.created", message: `Workspace "${body.name}" created`, ts: Date.now() });
  persist(ws);

  return { id, token, joinCode, joinCodeExpiresAt };
}, {
  body: t.Object({ name: t.Optional(t.String()), nodeId: t.Optional(t.String()) }),
});

/**
 * POST /workspace/join
 * Body: { code, nodeId }
 * Returns: { workspaceId, token, name }
 */
workspaceApi.post("/workspace/join", async ({ body, set}) => {
  if (!body.code || !body.nodeId) {
    set.status = 400; return { error: "code and nodeId are required" };
  }

  const ws = findByJoinCode(body.code.toUpperCase());
  if (!ws) {
    set.status = 404; return { error: "invalid or expired join code" };
  }

  // Check if node already joined
  if (!ws.nodes.find(n => n.nodeId === body.nodeId)) {
    const now = new Date().toISOString();
    ws.nodes.push({ nodeId: body.nodeId, joinedAt: now, lastSeen: now });
    pushFeed(ws, { nodeId: body.nodeId, type: "node.joined", message: `Node "${body.nodeId}" joined`, ts: Date.now() });
  }

  persist(ws);

  return { workspaceId: ws.id, token: ws.token, name: ws.name };
}, {
  body: t.Object({ code: t.Optional(t.String()), nodeId: t.Optional(t.String()) }),
});

// --- Authenticated /:id routes (HMAC required) ---

/** Helper: authenticate workspace from request context */
function authWorkspace(params: { id: string }, request: Request, headers: Record<string, string | undefined>): { ws: Workspace } | { error: string } {
  const workspaceId = params.id;
  const url = new URL(request.url);

  const ws = authenticateWorkspace(workspaceId, request.method, url.pathname, {
    sig: headers["x-maw-signature"],
    ts: headers["x-maw-timestamp"],
  });

  if (!ws) return { error: "workspace auth failed" };
  return { ws };
}

/**
 * POST /workspace/:id/agents
 * Body: { name, nodeId, status?, capabilities? }
 * Registers or updates an agent in the workspace.
 */
workspaceApi.post("/workspace/:id/agents", async ({ params, body, headers, request, set}) => {
  const auth = authWorkspace(params, request, headers);
  if ("error" in auth) { set.status = 401; return { error: auth.error }; }
  const ws = auth.ws;

  if (!body.name || !body.nodeId) {
    set.status = 400; return { error: "name and nodeId are required" };
  }

  const now = new Date().toISOString();
  const existing = ws.agents.find(a => a.name === body.name && a.nodeId === body.nodeId);

  if (existing) {
    existing.status = body.status || existing.status;
    existing.capabilities = body.capabilities || existing.capabilities;
    existing.updatedAt = now;
  } else {
    ws.agents.push({
      name: body.name,
      nodeId: body.nodeId,
      status: body.status || "registered",
      capabilities: body.capabilities || [],
      updatedAt: now,
    });
    pushFeed(ws, { nodeId: body.nodeId, type: "agent.registered", message: `Agent "${body.name}" registered from ${body.nodeId}`, ts: Date.now() });
  }

  touchNode(ws, body.nodeId);
  persist(ws);

  return { ok: true, agents: ws.agents.length };
}, {
  params: t.Object({ id: t.String() }),
  body: t.Object({
    name: t.Optional(t.String()),
    nodeId: t.Optional(t.String()),
    status: t.Optional(t.String()),
    capabilities: t.Optional(t.Array(t.String())),
  }),
});

/**
 * GET /workspace/:id/agents
 * Returns all agents in the workspace.
 */
workspaceApi.get("/workspace/:id/agents", ({ params, headers, request, set}) => {
  const auth = authWorkspace(params, request, headers);
  if ("error" in auth) { set.status = 401; return { error: auth.error }; }
  const ws = auth.ws;
  return { agents: ws.agents, total: ws.agents.length };
}, {
  params: t.Object({ id: t.String() }),
});

/**
 * GET /workspace/:id/status
 * Returns workspace status: nodes, agent count, health.
 */
workspaceApi.get("/workspace/:id/status", ({ params, headers, request, set}) => {
  const auth = authWorkspace(params, request, headers);
  if ("error" in auth) { set.status = 401; return { error: auth.error }; }
  const ws = auth.ws;

  const fiveMinAgo = Date.now() - 5 * 60_000;
  const healthyNodes = ws.nodes.filter(n => new Date(n.lastSeen).getTime() > fiveMinAgo);

  return {
    id: ws.id,
    name: ws.name,
    createdAt: ws.createdAt,
    nodes: ws.nodes,
    nodeCount: ws.nodes.length,
    healthyNodeCount: healthyNodes.length,
    agentCount: ws.agents.length,
    feedCount: ws.feed.length,
  };
}, {
  params: t.Object({ id: t.String() }),
});

/**
 * GET /workspace/:id/feed
 * Returns recent feed events. Query: ?limit=50
 */
workspaceApi.get("/workspace/:id/feed", ({ params, query, headers, request, set}) => {
  const auth = authWorkspace(params, request, headers);
  if ("error" in auth) { set.status = 401; return { error: auth.error }; }
  const ws = auth.ws;
  const limit = Math.min(200, +(query.limit || "50"));
  const events = ws.feed.slice(-limit).reverse();
  return { events, total: events.length };
}, {
  params: t.Object({ id: t.String() }),
  query: t.Object({ limit: t.Optional(t.String()) }),
});

/**
 * POST /workspace/:id/message
 * Body: { from, to?, text }
 * REST fallback for messaging. Appended to feed as message event.
 */
workspaceApi.post("/workspace/:id/message", async ({ params, body, headers, request, set}) => {
  const auth = authWorkspace(params, request, headers);
  if ("error" in auth) { set.status = 401; return { error: auth.error }; }
  const ws = auth.ws;

  if (!body.from || !body.text) {
    set.status = 400; return { error: "from and text are required" };
  }

  const target = body.to ? ` -> ${body.to}` : "";
  pushFeed(ws, {
    nodeId: body.from,
    type: "message",
    message: `[${body.from}${target}] ${body.text}`,
    ts: Date.now(),
  });

  persist(ws);

  return { ok: true };
}, {
  params: t.Object({ id: t.String() }),
  body: t.Object({
    from: t.Optional(t.String()),
    to: t.Optional(t.String()),
    text: t.Optional(t.String()),
  }),
});
