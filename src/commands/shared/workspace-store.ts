import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../config";
import { mawConfigPath, mawDataPath } from "../../core/xdg";

// ── Workspace data directory ────────────────────────────────────────
export function workspacesDir(): string {
  return mawDataPath("workspaces");
}

export const WORKSPACES_DIR = workspacesDir();

function legacyWorkspacesDir(): string {
  return mawConfigPath("workspaces");
}

function candidateWorkspacesDirs(): string[] {
  const primary = workspacesDir();
  const legacy = legacyWorkspacesDir();
  return primary === legacy ? [primary] : [primary, legacy];
}

function ensureDir(): void {
  mkdirSync(workspacesDir(), { recursive: true });
}

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

export function configPath(id: string): string {
  return join(workspacesDir(), `${id}.json`);
}

function legacyConfigPath(id: string): string {
  return join(legacyWorkspacesDir(), `${id}.json`);
}

function candidateConfigPaths(id: string): string[] {
  const primary = configPath(id);
  const legacy = legacyConfigPath(id);
  return primary === legacy ? [primary] : [primary, legacy];
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

export function loadWorkspace(id: string): WorkspaceConfig | null {
  for (const p of candidateConfigPaths(id)) {
    if (!existsSync(p)) continue;
    try {
      return normalizeWorkspace(JSON.parse(readFileSync(p, "utf-8")));
    } catch {
      return null;
    }
  }
  return null;
}

export function saveWorkspace(ws: WorkspaceConfig): void {
  ensureDir();
  writeFileSync(configPath(ws.id), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}

export function loadAllWorkspaces(): WorkspaceConfig[] {
  try {
    ensureDir();
    const byId = new Map<string, WorkspaceConfig>();
    for (const dir of [...candidateWorkspacesDirs()].reverse()) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
        try {
          const ws = normalizeWorkspace(JSON.parse(readFileSync(join(dir, f), "utf-8")));
          if (ws) byId.set(ws.id, ws);
        } catch {
          // skip corrupt workspace records
        }
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

/** Print "no workspace ID" error with the list of joined workspaces if any */
export function reportNoWorkspaceId(): void {
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
export function resolveHubUrl(explicit?: string): string | null {
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
export function resolveWorkspaceId(explicit?: string): string | null {
  if (explicit) return explicit;
  const workspaces = loadAllWorkspaces();
  if (workspaces.length === 1) return workspaces[0].id;
  return null;
}
