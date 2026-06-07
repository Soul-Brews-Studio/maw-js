import { loadConfig } from "../../config";
import { curlFetch } from "../../sdk";
import { configPath, resolveHubUrl, resolveWorkspaceId, reportNoWorkspaceId, loadWorkspace, saveWorkspace } from "./workspace-store";
import type { WorkspaceConfig } from "./workspace-store";
type RenameSync = typeof import("fs").renameSync;
type UnlinkSync = typeof import("fs").unlinkSync;

function dynamicFs(): typeof import("fs") {
  return require("fs") as typeof import("fs");
}

export interface WorkspaceLifecycleDeps {
  loadConfig: typeof loadConfig;
  curlFetch: typeof curlFetch;
  resolveHubUrl: typeof resolveHubUrl;
  resolveWorkspaceId: typeof resolveWorkspaceId;
  reportNoWorkspaceId: typeof reportNoWorkspaceId;
  loadWorkspace: typeof loadWorkspace;
  saveWorkspace: typeof saveWorkspace;
  configPath: typeof configPath;
  renameSync: RenameSync;
  unlinkSync: UnlinkSync;
  now: () => Date;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never;
}

function lifecycleDeps(overrides: Partial<WorkspaceLifecycleDeps> = {}): WorkspaceLifecycleDeps {
  return {
    loadConfig: overrides.loadConfig ?? loadConfig,
    curlFetch: overrides.curlFetch ?? curlFetch,
    resolveHubUrl: overrides.resolveHubUrl ?? resolveHubUrl,
    resolveWorkspaceId: overrides.resolveWorkspaceId ?? resolveWorkspaceId,
    reportNoWorkspaceId: overrides.reportNoWorkspaceId ?? reportNoWorkspaceId,
    loadWorkspace: overrides.loadWorkspace ?? loadWorkspace,
    saveWorkspace: overrides.saveWorkspace ?? saveWorkspace,
    configPath: overrides.configPath ?? configPath,
    renameSync: overrides.renameSync ?? ((src, dest) => dynamicFs().renameSync(src, dest)),
    unlinkSync: overrides.unlinkSync ?? ((src) => dynamicFs().unlinkSync(src)),
    now: overrides.now ?? (() => new Date()),
    log: overrides.log ?? console.log,
    error: overrides.error ?? console.error,
    exit: overrides.exit ?? ((code: number): never => process.exit(code)),
  };
}

/** maw workspace create <name> [--hub <url>] */
export async function cmdWorkspaceCreate(name: string, hubUrl?: string, deps: Partial<WorkspaceLifecycleDeps> = {}) {
  const d = lifecycleDeps(deps);
  const hub = d.resolveHubUrl(hubUrl);
  if (!hub) {
    d.error("\x1b[31m\u274c\x1b[0m no hub URL — pass --hub <url> or configure a peer");
    d.exit(1);
  }

  d.log(`\x1b[36mcreating\x1b[0m workspace "${name}" on ${hub}...`);

  const config = d.loadConfig();
  const res = await d.curlFetch(`${hub}/api/workspace/create`, {
    method: "POST",
    body: JSON.stringify({ name, nodeId: config.node ?? "local" }),
  });

  if (!res.ok || !res.data?.id) {
    d.error(`\x1b[31m\u274c\x1b[0m failed to create workspace: ${res.data?.error || `HTTP ${res.status}`}`);
    d.exit(1);
  }

  const ws: WorkspaceConfig = {
    id: res.data.id,
    name: res.data.name || name,
    hubUrl: hub,
    joinCode: res.data.joinCode,
    sharedAgents: [],
    joinedAt: d.now().toISOString(),
    lastStatus: "connected",
  };
  d.saveWorkspace(ws);

  d.log(`\x1b[32m\u2705\x1b[0m workspace created`);
  d.log(`  \x1b[36mID:\x1b[0m        ${ws.id}`);
  d.log(`  \x1b[36mName:\x1b[0m      ${ws.name}`);
  d.log(`  \x1b[36mHub:\x1b[0m       ${ws.hubUrl}`);
  if (ws.joinCode) {
    d.log(`  \x1b[36mJoin code:\x1b[0m ${ws.joinCode}`);
  }
  d.log(`\n\x1b[90mConfig saved to ${d.configPath(ws.id)}\x1b[0m`);
}

/** maw workspace join <code> [--hub <url>] */
export async function cmdWorkspaceJoin(code: string, hubUrl?: string, deps: Partial<WorkspaceLifecycleDeps> = {}) {
  const d = lifecycleDeps(deps);
  const hub = d.resolveHubUrl(hubUrl);
  if (!hub) {
    d.error("\x1b[31m\u274c\x1b[0m no hub URL — pass --hub <url> or configure a peer");
    d.exit(1);
  }

  d.log(`\x1b[36mjoining\x1b[0m workspace with code "${code}" on ${hub}...`);

  const config = d.loadConfig();
  const res = await d.curlFetch(`${hub}/api/workspace/join`, {
    method: "POST",
    body: JSON.stringify({ code, node: config.node ?? "local" }),
  });

  if (!res.ok || !res.data?.id) {
    d.error(`\x1b[31m\u274c\x1b[0m failed to join workspace: ${res.data?.error || `HTTP ${res.status}`}`);
    d.exit(1);
  }

  const ws: WorkspaceConfig = {
    id: res.data.id,
    name: res.data.name || "unknown",
    hubUrl: hub,
    joinCode: code,
    sharedAgents: [],
    joinedAt: d.now().toISOString(),
    lastStatus: "connected",
  };
  d.saveWorkspace(ws);

  d.log(`\x1b[32m\u2705\x1b[0m joined workspace`);
  d.log(`  \x1b[36mName:\x1b[0m    ${ws.name}`);
  d.log(`  \x1b[36mID:\x1b[0m      ${ws.id}`);
  if (res.data.agents?.length) {
    d.log(`  \x1b[36mAgents:\x1b[0m  ${res.data.agents.length} available`);
    for (const a of res.data.agents) {
      d.log(`    \x1b[90m\u2022\x1b[0m ${a.name || a}`);
    }
  }
  d.log(`\n\x1b[90mConfig saved to ${d.configPath(ws.id)}\x1b[0m`);
}

/** maw workspace leave [workspace-id] */
export async function cmdWorkspaceLeave(workspaceId?: string, deps: Partial<WorkspaceLifecycleDeps> = {}) {
  const d = lifecycleDeps(deps);
  const id = d.resolveWorkspaceId(workspaceId);
  if (!id) {
    d.reportNoWorkspaceId();
    d.exit(1);
  }

  const ws = d.loadWorkspace(id);
  if (!ws) {
    d.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    d.exit(1);
  }

  d.log(`\x1b[36mleaving\x1b[0m workspace "${ws.name}"...`);

  const config = d.loadConfig();
  const res = await d.curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/leave`, {
    method: "POST",
    body: JSON.stringify({ node: config.node ?? "local" }),
  });

  if (!res.ok) {
    d.error(`\x1b[31m\u274c\x1b[0m failed to leave workspace: ${res.data?.error || `HTTP ${res.status}`}`);
    // Still remove local config — hub might be unreachable
    d.log("\x1b[33m\u26a0\x1b[0m removing local config anyway...");
  }

  // Remove local workspace config (soft-delete: rename with .left suffix)
  const src = d.configPath(ws.id);
  const dest = d.configPath(ws.id + ".left");
  try {
    d.renameSync(src, dest);
  } catch {
    // If rename fails, just delete
    try {
      d.unlinkSync(src);
    } catch {}
  }

  d.log(`\x1b[32m\u2705\x1b[0m left workspace "${ws.name}"`);
  d.log(`\x1b[90m  config archived to ${dest}\x1b[0m`);
}
