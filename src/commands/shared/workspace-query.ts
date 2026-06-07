import { cfgTimeout as defaultCfgTimeout } from "../../config";
import { curlFetch as defaultCurlFetch } from "../../sdk";
import {
  resolveWorkspaceId as defaultResolveWorkspaceId,
  reportNoWorkspaceId as defaultReportNoWorkspaceId,
  loadWorkspace as defaultLoadWorkspace,
  loadAllWorkspaces as defaultLoadAllWorkspaces,
  saveWorkspace as defaultSaveWorkspace,
} from "./workspace-store";
import type { WorkspaceConfig } from "./workspace-store";

export interface WorkspaceQueryDeps {
  resolveWorkspaceId?: (explicit?: string) => string | null;
  reportNoWorkspaceId?: () => void;
  loadWorkspace?: (id: string) => WorkspaceConfig | null;
  loadAllWorkspaces?: () => WorkspaceConfig[];
  saveWorkspace?: (ws: WorkspaceConfig) => void;
  cfgTimeout?: typeof defaultCfgTimeout;
  curlFetch?: typeof defaultCurlFetch;
  log?: Pick<Console, "log" | "error">;
  exit?: (code?: number) => never;
  now?: () => number;
}

function workspaceQueryDeps(deps: WorkspaceQueryDeps) {
  return {
    resolveWorkspaceId: deps.resolveWorkspaceId ?? defaultResolveWorkspaceId,
    reportNoWorkspaceId: deps.reportNoWorkspaceId ?? defaultReportNoWorkspaceId,
    loadWorkspace: deps.loadWorkspace ?? defaultLoadWorkspace,
    loadAllWorkspaces: deps.loadAllWorkspaces ?? defaultLoadAllWorkspaces,
    saveWorkspace: deps.saveWorkspace ?? defaultSaveWorkspace,
    cfgTimeout: deps.cfgTimeout ?? defaultCfgTimeout,
    curlFetch: deps.curlFetch ?? defaultCurlFetch,
    log: deps.log ?? console,
    exit: deps.exit ?? process.exit,
    now: deps.now ?? Date.now,
  };
}

/** maw workspace ls */
export async function cmdWorkspaceLs(deps: WorkspaceQueryDeps = {}) {
  const d = workspaceQueryDeps(deps);
  const workspaces = d.loadAllWorkspaces();

  if (workspaces.length === 0) {
    d.log.log("\x1b[90mNo workspaces configured.\x1b[0m");
    d.log.log("\x1b[90m  maw workspace create <name>   Create a new workspace\x1b[0m");
    d.log.log("\x1b[90m  maw workspace join <code>     Join with invite code\x1b[0m");
    return;
  }

  d.log.log(`\n\x1b[36;1mWorkspaces\x1b[0m  \x1b[90m${workspaces.length} joined\x1b[0m\n`);

  for (const ws of workspaces) {
    const statusDot = ws.lastStatus === "connected"
      ? "\x1b[32m\u25cf\x1b[0m"
      : "\x1b[31m\u25cf\x1b[0m";
    const agentCount = ws.sharedAgents.length;
    const agentLabel = agentCount === 0
      ? "\x1b[90mno agents shared\x1b[0m"
      : `${agentCount} agent${agentCount !== 1 ? "s" : ""} shared`;

    d.log.log(`  ${statusDot}  \x1b[37;1m${ws.name}\x1b[0m  \x1b[90m(${ws.id})\x1b[0m`);
    d.log.log(`     \x1b[36mHub:\x1b[0m     ${ws.hubUrl}`);
    d.log.log(`     \x1b[36mAgents:\x1b[0m  ${agentLabel}`);
    if (ws.sharedAgents.length > 0) {
      d.log.log(`     \x1b[90m         ${ws.sharedAgents.join(", ")}\x1b[0m`);
    }
    d.log.log(`     \x1b[90mJoined:  ${ws.joinedAt}\x1b[0m`);
  }
  d.log.log();
}

/** maw workspace invite [workspace-id] */
export async function cmdWorkspaceInvite(workspaceId?: string, deps: WorkspaceQueryDeps = {}) {
  const d = workspaceQueryDeps(deps);
  const id = d.resolveWorkspaceId(workspaceId);
  if (!id) {
    d.reportNoWorkspaceId();
    d.exit(1);
  }

  const ws = d.loadWorkspace(id);
  if (!ws) {
    d.log.error(`\x1b[31m\u274c\x1b[0m workspace not found: ${id}`);
    d.exit(1);
  }

  const res = await d.curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/status`, { timeout: d.cfgTimeout("workspace") });

  if (!res.ok) {
    d.log.error(`\x1b[31m\u274c\x1b[0m failed to fetch invite info: ${res.data?.error || `HTTP ${res.status}`}`);
    d.exit(1);
  }

  const joinCode = res.data?.joinCode || ws.joinCode;
  if (!joinCode) {
    d.log.error("\x1b[31m\u274c\x1b[0m no join code available for this workspace");
    d.exit(1);
  }

  d.log.log(`\n\x1b[36;1m${ws.name}\x1b[0m  \x1b[90mInvite\x1b[0m\n`);
  d.log.log(`  \x1b[36mJoin code:\x1b[0m  ${joinCode}`);
  if (res.data?.expiry) {
    d.log.log(`  \x1b[36mExpires:\x1b[0m    ${res.data.expiry}`);
  }
  d.log.log(`\n  \x1b[90mTo join:\x1b[0m  maw workspace join ${joinCode} --hub ${ws.hubUrl}`);
  d.log.log();
}

/** maw workspace status */
export async function cmdWorkspaceStatus(deps: WorkspaceQueryDeps = {}) {
  const d = workspaceQueryDeps(deps);
  const workspaces = d.loadAllWorkspaces();

  if (workspaces.length === 0) {
    d.log.log("\x1b[90mNo workspaces configured.\x1b[0m");
    return;
  }

  d.log.log(`\n\x1b[36;1mWorkspace Status\x1b[0m  \x1b[90m${workspaces.length} workspace${workspaces.length !== 1 ? "s" : ""}\x1b[0m\n`);

  const results = await Promise.all(
    workspaces.map(async (ws) => {
      const start = d.now();
      try {
        const res = await d.curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/status`, { timeout: d.cfgTimeout("workspace") });
        const ms = d.now() - start;
        if (res.ok) {
          ws.lastStatus = "connected";
          d.saveWorkspace(ws);
          return {
            ws,
            ok: true,
            ms,
            agentCount: res.data?.agentCount ?? 0,
            nodeCount: res.data?.nodeCount ?? 0,
          };
        }
        ws.lastStatus = "disconnected";
        d.saveWorkspace(ws);
        return { ws, ok: false, ms, agentCount: 0, nodeCount: 0 };
      } catch {
        ws.lastStatus = "disconnected";
        d.saveWorkspace(ws);
        return { ws, ok: false, ms: d.now() - start, agentCount: 0, nodeCount: 0 };
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

    d.log.log(`  ${dot}  \x1b[37;1m${r.ws.name}\x1b[0m  ${status}`);
    d.log.log(`     \x1b[90m${r.ws.hubUrl}\x1b[0m`);
  }

  d.log.log(`\n\x1b[90m${online}/${workspaces.length} connected\x1b[0m\n`);
}
