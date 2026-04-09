import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig, cfgTimeout } from "../config";
import { curlFetch } from "../curl-fetch";

// ── Workspace config directory ──────────────────────────────────────
const WORKSPACES_DIR = join(
  process.env.MAW_CONFIG_DIR || join(homedir(), ".config", "maw"),
  "workspaces"
);
mkdirSync(WORKSPACES_DIR, { recursive: true });

// ── Types ───────────────────────────────────────────────────────────
export interface WorkspaceConfig {
  id: string;
  name: string;
  hubUrl: string;
  joinCode?: string;
  sharedAgents: string[];
  joinedAt: string;
  lastStatus?: "connected" | "disconnected";
}

// ── Helpers ─────────────────────────────────────────────────────────

function configPath(id: string): string {
  return join(WORKSPACES_DIR, `${id}.json`);
}

/**
 * Normalize a parsed workspace file into the current `WorkspaceConfig` shape.
 *
 * Returns null for entries without a usable `id`. Missing optional fields get
 * safe defaults so downstream code can trust the shape:
 *
 * - `hubUrl` defaults to `""` (rendered as "(unknown hub)" in ls output)
 * - `sharedAgents` defaults to `[]`
 * - `joinedAt` falls back to `createdAt` (preserves info from legacy files)
 * - `lastStatus` is whitelisted to the two valid values
 *
 * Early versions of `maw workspace create` (around commit 15830d2,
 * 2026-03-30) wrote server-side-shaped files into ~/.config/maw/workspaces/
 * that are missing `hubUrl`, `sharedAgents`, and `joinedAt`. See #194.
 */
export function normalizeWorkspace(raw: unknown): WorkspaceConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;

  const sharedAgents = Array.isArray(r.sharedAgents)
    ? r.sharedAgents.filter((a): a is string => typeof a === "string")
    : [];

  const joinedAt =
    typeof r.joinedAt === "string"
      ? r.joinedAt
      : typeof r.createdAt === "string"
      ? r.createdAt
      : "";

  const lastStatus =
    r.lastStatus === "connected" || r.lastStatus === "disconnected"
      ? (r.lastStatus as "connected" | "disconnected")
      : undefined;

  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "(unnamed)",
    hubUrl: typeof r.hubUrl === "string" ? r.hubUrl : "",
    joinCode: typeof r.joinCode === "string" ? r.joinCode : undefined,
    sharedAgents,
    joinedAt,
    lastStatus,
  };
}

function loadWorkspace(id: string): WorkspaceConfig | null {
  const p = configPath(id);
  if (!existsSync(p)) return null;
  try {
    return normalizeWorkspace(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    return null;
  }
}

function saveWorkspace(ws: WorkspaceConfig): void {
  writeFileSync(configPath(ws.id), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}

function loadAllWorkspaces(): WorkspaceConfig[] {
  try {
    const files = readdirSync(WORKSPACES_DIR).filter(f => f.endsWith(".json"));
    return files
      .map(f => {
        try {
          return normalizeWorkspace(JSON.parse(readFileSync(join(WORKSPACES_DIR, f), "utf-8")));
        } catch {
          return null;
        }
      })
      .filter((ws): ws is WorkspaceConfig => ws !== null);
  } catch {
    return [];
  }
}

/** Print "no workspace ID" error with the list of joined workspaces if any */
function reportNoWorkspaceId(): void {
  const all = loadAllWorkspaces();
  if (all.length === 0) {
    console.error("\x1b[31m\u274c\x1b[0m no workspaces joined");
    console.error("\x1b[90m  maw workspace create <name>   Create a new workspace\x1b[0m");
    console.error("\x1b[90m  maw workspace join <code>     Join with invite code\x1b[0m");
    return;
  }
  console.error(`\x1b[31m\u274c\x1b[0m multiple workspaces joined (${all.length}) — pass one with --workspace <id>:`);
  for (const ws of all) {
    console.error(`  \x1b[90m${ws.id}\x1b[0m  ${ws.name}`);
  }
}

/** Resolve hub URL — explicit arg > first workspace's hubUrl > config peers */
function resolveHubUrl(explicit?: string): string | null {
  if (explicit) return explicit;
  const workspaces = loadAllWorkspaces();
  if (workspaces.length > 0) return workspaces[0].hubUrl;
  const config = loadConfig();
  const peer = config.namedPeers?.[0];
  if (peer) return peer.url;
  if (config.peers?.[0]) return config.peers[0];
  return null;
}

/** Resolve workspace ID — explicit arg or default to first workspace */
function resolveWorkspaceId(explicit?: string): string | null {
  if (explicit) return explicit;
  const workspaces = loadAllWorkspaces();
  if (workspaces.length === 1) return workspaces[0].id;
  return null;
}

// ── Commands ────────────────────────────────────────────────────────

/** maw workspace create <name> [--hub <url>] */
export async function cmdWorkspaceCreate(name: string, hubUrl?: string) {
  const hub = resolveHubUrl(hubUrl);
  if (!hub) {
    console.error("\x1b[31m\u274c\x1b[0m no hub URL — pass --hub <url> or configure a peer");
    process.exit(1);
  }

  console.log(`\x1b[36mcreating\x1b[0m workspace "${name}" on ${hub}...`);

  const config = loadConfig();
  const res = await curlFetch(`${hub}/api/workspace/create`, {
    method: "POST",
    body: JSON.stringify({ name, nodeId: config.node ?? "local" }),
  });

  if (!res.ok || !res.data?.id) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to create workspace: ${res.data?.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  const ws: WorkspaceConfig = {
    id: res.data.id,
    name: res.data.name || name,
    hubUrl: hub,
    joinCode: res.data.joinCode,
    sharedAgents: [],
    joinedAt: new Date().toISOString(),
    lastStatus: "connected",
  };
  saveWorkspace(ws);

  console.log(`\x1b[32m\u2705\x1b[0m workspace created`);
  console.log(`  \x1b[36mID:\x1b[0m        ${ws.id}`);
  console.log(`  \x1b[36mName:\x1b[0m      ${ws.name}`);
  console.log(`  \x1b[36mHub:\x1b[0m       ${ws.hubUrl}`);
  if (ws.joinCode) {
    console.log(`  \x1b[36mJoin code:\x1b[0m ${ws.joinCode}`);
  }
  console.log(`\n\x1b[90mConfig saved to ${configPath(ws.id)}\x1b[0m`);
}

/** maw workspace join <code> [--hub <url>] */
export async function cmdWorkspaceJoin(code: string, hubUrl?: string) {
  const hub = resolveHubUrl(hubUrl);
  if (!hub) {
    console.error("\x1b[31m\u274c\x1b[0m no hub URL — pass --hub <url> or configure a peer");
    process.exit(1);
  }

  console.log(`\x1b[36mjoining\x1b[0m workspace with code "${code}" on ${hub}...`);

  const config = loadConfig();
  const res = await curlFetch(`${hub}/api/workspace/join`, {
    method: "POST",
    body: JSON.stringify({ code, node: config.node ?? "local" }),
  });

  if (!res.ok || !res.data?.id) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to join workspace: ${res.data?.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  const ws: WorkspaceConfig = {
    id: res.data.id,
    name: res.data.name || "unknown",
    hubUrl: hub,
    joinCode: code,
    sharedAgents: [],
    joinedAt: new Date().toISOString(),
    lastStatus: "connected",
  };
  saveWorkspace(ws);

  console.log(`\x1b[32m\u2705\x1b[0m joined workspace`);
  console.log(`  \x1b[36mName:\x1b[0m    ${ws.name}`);
  console.log(`  \x1b[36mID:\x1b[0m      ${ws.id}`);
  if (res.data.agents?.length) {
    console.log(`  \x1b[36mAgents:\x1b[0m  ${res.data.agents.length} available`);
    for (const a of res.data.agents) {
      console.log(`    \x1b[90m\u2022\x1b[0m ${a.name || a}`);
    }
  }
  console.log(`\n\x1b[90mConfig saved to ${configPath(ws.id)}\x1b[0m`);
}

/** maw workspace share <agent...> [--workspace <id>] */
export async function cmdWorkspaceShare(agents: string[], workspaceId?: string) {
  const id = resolveWorkspaceId(workspaceId);
  if (!id) {
    reportNoWorkspaceId();
    process.exit(1);
  }

  const ws = loadWorkspace(id);
  if (!ws) {
    console.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    process.exit(1);
  }

  console.log(`\x1b[36msharing\x1b[0m ${agents.length} agent(s) to workspace "${ws.name}"...`);

  const config = loadConfig();
  const res = await curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/agents`, {
    method: "POST",
    body: JSON.stringify({ action: "share", agents, node: config.node ?? "local" }),
  });

  if (!res.ok) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to share agents: ${res.data?.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  // Update local config
  const newAgents = new Set([...ws.sharedAgents, ...agents]);
  ws.sharedAgents = [...newAgents];
  saveWorkspace(ws);

  console.log(`\x1b[32m\u2705\x1b[0m shared ${agents.length} agent(s)`);
  for (const a of agents) {
    console.log(`  \x1b[32m+\x1b[0m ${a}`);
  }
  console.log(`\x1b[90m  total shared: ${ws.sharedAgents.length}\x1b[0m`);
}

/** maw workspace unshare <agent...> [--workspace <id>] */
export async function cmdWorkspaceUnshare(agents: string[], workspaceId?: string) {
  const id = resolveWorkspaceId(workspaceId);
  if (!id) {
    reportNoWorkspaceId();
    process.exit(1);
  }

  const ws = loadWorkspace(id);
  if (!ws) {
    console.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    process.exit(1);
  }

  console.log(`\x1b[36mremoving\x1b[0m ${agents.length} agent(s) from workspace "${ws.name}"...`);

  const config = loadConfig();
  const res = await curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/agents`, {
    method: "POST",
    body: JSON.stringify({ action: "unshare", agents, node: config.node ?? "local" }),
  });

  if (!res.ok) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to unshare agents: ${res.data?.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  // Update local config
  const removeSet = new Set(agents);
  ws.sharedAgents = ws.sharedAgents.filter(a => !removeSet.has(a));
  saveWorkspace(ws);

  console.log(`\x1b[32m\u2705\x1b[0m removed ${agents.length} agent(s)`);
  for (const a of agents) {
    console.log(`  \x1b[31m-\x1b[0m ${a}`);
  }
  console.log(`\x1b[90m  total shared: ${ws.sharedAgents.length}\x1b[0m`);
}

/** maw workspace ls */
export async function cmdWorkspaceLs() {
  const workspaces = loadAllWorkspaces();

  if (workspaces.length === 0) {
    console.log("\x1b[90mNo workspaces configured.\x1b[0m");
    console.log("\x1b[90m  maw workspace create <name>   Create a new workspace\x1b[0m");
    console.log("\x1b[90m  maw workspace join <code>     Join with invite code\x1b[0m");
    return;
  }

  console.log(`\n\x1b[36;1mWorkspaces\x1b[0m  \x1b[90m${workspaces.length} joined\x1b[0m\n`);

  for (const ws of workspaces) {
    const statusDot = ws.lastStatus === "connected"
      ? "\x1b[32m\u25cf\x1b[0m"
      : "\x1b[31m\u25cf\x1b[0m";
    const agentCount = ws.sharedAgents.length;
    const agentLabel = agentCount === 0
      ? "\x1b[90mno agents shared\x1b[0m"
      : `${agentCount} agent${agentCount !== 1 ? "s" : ""} shared`;

    console.log(`  ${statusDot}  \x1b[37;1m${ws.name}\x1b[0m  \x1b[90m(${ws.id})\x1b[0m`);
    console.log(`     \x1b[36mHub:\x1b[0m     ${ws.hubUrl}`);
    console.log(`     \x1b[36mAgents:\x1b[0m  ${agentLabel}`);
    if (ws.sharedAgents.length > 0) {
      console.log(`     \x1b[90m         ${ws.sharedAgents.join(", ")}\x1b[0m`);
    }
    console.log(`     \x1b[90mJoined:  ${ws.joinedAt}\x1b[0m`);
  }
  console.log();
}

/** maw workspace agents [workspace-id] */
export async function cmdWorkspaceAgents(workspaceId?: string) {
  const id = resolveWorkspaceId(workspaceId);
  if (!id) {
    reportNoWorkspaceId();
    process.exit(1);
  }

  const ws = loadWorkspace(id);
  if (!ws) {
    console.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    process.exit(1);
  }

  console.log(`\x1b[36mfetching\x1b[0m agents for workspace "${ws.name}"...`);

  const res = await curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/agents`, { timeout: cfgTimeout("workspace") });

  if (!res.ok) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to fetch agents: ${res.data?.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  const nodes: Record<string, string[]> = res.data?.nodes || {};
  const nodeNames = Object.keys(nodes);

  if (nodeNames.length === 0) {
    console.log("\x1b[90mNo agents in workspace yet.\x1b[0m");
    console.log("\x1b[90m  maw workspace share <agent...>  Share your agents\x1b[0m");
    return;
  }

  console.log(`\n\x1b[36;1m${ws.name}\x1b[0m  \x1b[90mAgents by node\x1b[0m\n`);

  let totalAgents = 0;
  for (const node of nodeNames) {
    const agents = nodes[node] || [];
    totalAgents += agents.length;
    console.log(`  \x1b[37;1m${node}\x1b[0m  \x1b[90m(${agents.length} agent${agents.length !== 1 ? "s" : ""})\x1b[0m`);
    for (const a of agents) {
      console.log(`    \x1b[90m\u25cf\x1b[0m ${a}`);
    }
  }

  console.log(`\n\x1b[90m${totalAgents} total agents across ${nodeNames.length} node${nodeNames.length !== 1 ? "s" : ""}\x1b[0m\n`);
}

/** maw workspace invite [workspace-id] */
export async function cmdWorkspaceInvite(workspaceId?: string) {
  const id = resolveWorkspaceId(workspaceId);
  if (!id) {
    reportNoWorkspaceId();
    process.exit(1);
  }

  const ws = loadWorkspace(id);
  if (!ws) {
    console.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    process.exit(1);
  }

  const res = await curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/status`, { timeout: cfgTimeout("workspace") });

  if (!res.ok) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to fetch invite info: ${res.data?.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }

  const joinCode = res.data?.joinCode || ws.joinCode;
  if (!joinCode) {
    console.error("\x1b[31m\u274c\x1b[0m no join code available for this workspace");
    process.exit(1);
  }

  console.log(`\n\x1b[36;1m${ws.name}\x1b[0m  \x1b[90mInvite\x1b[0m\n`);
  console.log(`  \x1b[36mJoin code:\x1b[0m  ${joinCode}`);
  if (res.data?.expiry) {
    console.log(`  \x1b[36mExpires:\x1b[0m    ${res.data.expiry}`);
  }
  console.log(`\n  \x1b[90mTo join:\x1b[0m  maw workspace join ${joinCode} --hub ${ws.hubUrl}`);
  console.log();
}

/** maw workspace leave [workspace-id] */
export async function cmdWorkspaceLeave(workspaceId?: string) {
  const id = resolveWorkspaceId(workspaceId);
  if (!id) {
    reportNoWorkspaceId();
    process.exit(1);
  }

  const ws = loadWorkspace(id);
  if (!ws) {
    console.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    process.exit(1);
  }

  console.log(`\x1b[36mleaving\x1b[0m workspace "${ws.name}"...`);

  const config = loadConfig();
  const res = await curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/leave`, {
    method: "POST",
    body: JSON.stringify({ node: config.node ?? "local" }),
  });

  if (!res.ok) {
    console.error(`\x1b[31m\u274c\x1b[0m failed to leave workspace: ${res.data?.error || `HTTP ${res.status}`}`);
    // Still remove local config — hub might be unreachable
    console.log("\x1b[33m\u26a0\x1b[0m removing local config anyway...");
  }

  // Remove local workspace config (soft-delete: rename with .left suffix)
  const src = configPath(ws.id);
  const dest = configPath(ws.id + ".left");
  try {
    const { renameSync } = require("fs");
    renameSync(src, dest);
  } catch {
    // If rename fails, just delete
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(src);
    } catch {}
  }

  console.log(`\x1b[32m\u2705\x1b[0m left workspace "${ws.name}"`);
  console.log(`\x1b[90m  config archived to ${dest}\x1b[0m`);
}

/** maw workspace status */
export async function cmdWorkspaceStatus() {
  const workspaces = loadAllWorkspaces();

  if (workspaces.length === 0) {
    console.log("\x1b[90mNo workspaces configured.\x1b[0m");
    return;
  }

  console.log(`\n\x1b[36;1mWorkspace Status\x1b[0m  \x1b[90m${workspaces.length} workspace${workspaces.length !== 1 ? "s" : ""}\x1b[0m\n`);

  const results = await Promise.all(
    workspaces.map(async (ws) => {
      const start = Date.now();
      try {
        const res = await curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/status`, { timeout: cfgTimeout("workspace") });
        const ms = Date.now() - start;
        if (res.ok) {
          ws.lastStatus = "connected";
          saveWorkspace(ws);
          return {
            ws,
            ok: true,
            ms,
            agentCount: res.data?.agentCount ?? 0,
            nodeCount: res.data?.nodeCount ?? 0,
          };
        }
        ws.lastStatus = "disconnected";
        saveWorkspace(ws);
        return { ws, ok: false, ms, agentCount: 0, nodeCount: 0 };
      } catch {
        ws.lastStatus = "disconnected";
        saveWorkspace(ws);
        return { ws, ok: false, ms: Date.now() - start, agentCount: 0, nodeCount: 0 };
      }
    })
  );

  let online = 0;
  for (const r of results) {
    if (r.ok) online++;
    const dot = r.ok ? "\x1b[32m\u25cf\x1b[0m" : "\x1b[31m\u25cf\x1b[0m";
    const status = r.ok
      ? `\x1b[32mconnected\x1b[0m  \x1b[90m${r.ms}ms \u00b7 ${r.agentCount} agent${r.agentCount !== 1 ? "s" : ""} \u00b7 ${r.nodeCount} node${r.nodeCount !== 1 ? "s" : ""}\x1b[0m`
      : `\x1b[31mdisconnected\x1b[0m  \x1b[90m${r.ms}ms\x1b[0m`;

    console.log(`  ${dot}  \x1b[37;1m${r.ws.name}\x1b[0m  ${status}`);
    console.log(`     \x1b[90m${r.ws.hubUrl}\x1b[0m`);
  }

  console.log(`\n\x1b[90m${online}/${workspaces.length} connected\x1b[0m\n`);
}
