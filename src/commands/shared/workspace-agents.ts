import { loadConfig as defaultLoadConfig, cfgTimeout as defaultCfgTimeout } from "../../config";
import { curlFetch as defaultCurlFetch } from "../../sdk";
import {
  resolveWorkspaceId as defaultResolveWorkspaceId,
  reportNoWorkspaceId as defaultReportNoWorkspaceId,
  loadWorkspace as defaultLoadWorkspace,
  saveWorkspace as defaultSaveWorkspace,
} from "./workspace-store";
import type { WorkspaceConfig } from "./workspace-store";

export interface WorkspaceAgentsDeps {
  resolveWorkspaceId?: (explicit?: string) => string | null;
  reportNoWorkspaceId?: () => void;
  loadWorkspace?: (id: string) => WorkspaceConfig | null;
  saveWorkspace?: (ws: WorkspaceConfig) => void;
  loadConfig?: typeof defaultLoadConfig;
  cfgTimeout?: typeof defaultCfgTimeout;
  curlFetch?: typeof defaultCurlFetch;
  log?: Pick<Console, "log" | "error">;
  exit?: (code?: number) => never;
}

function workspaceAgentDeps(deps: WorkspaceAgentsDeps) {
  return {
    resolveWorkspaceId: deps.resolveWorkspaceId ?? defaultResolveWorkspaceId,
    reportNoWorkspaceId: deps.reportNoWorkspaceId ?? defaultReportNoWorkspaceId,
    loadWorkspace: deps.loadWorkspace ?? defaultLoadWorkspace,
    saveWorkspace: deps.saveWorkspace ?? defaultSaveWorkspace,
    loadConfig: deps.loadConfig ?? defaultLoadConfig,
    cfgTimeout: deps.cfgTimeout ?? defaultCfgTimeout,
    curlFetch: deps.curlFetch ?? defaultCurlFetch,
    log: deps.log ?? console,
    exit: deps.exit ?? process.exit,
  };
}

/** maw workspace share <agent...> [--workspace <id>] */
export async function cmdWorkspaceShare(agents: string[], workspaceId?: string, deps: WorkspaceAgentsDeps = {}) {
  const d = workspaceAgentDeps(deps);
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

  d.log.log(`\x1b[36msharing\x1b[0m ${agents.length} agent(s) to workspace "${ws.name}"...`);

  const config = d.loadConfig();
  const res = await d.curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/agents`, {
    method: "POST",
    body: JSON.stringify({ action: "share", agents, node: config.node ?? "local" }),
  });

  if (!res.ok) {
    d.log.error(`\x1b[31m\u274c\x1b[0m failed to share agents: ${res.data?.error || `HTTP ${res.status}`}`);
    d.exit(1);
  }

  // Update local config
  const newAgents = new Set([...ws.sharedAgents, ...agents]);
  ws.sharedAgents = [...newAgents];
  d.saveWorkspace(ws);

  d.log.log(`\x1b[32m\u2705\x1b[0m shared ${agents.length} agent(s)`);
  for (const a of agents) {
    d.log.log(`  \x1b[32m+\x1b[0m ${a}`);
  }
  d.log.log(`\x1b[90m  total shared: ${ws.sharedAgents.length}\x1b[0m`);
}

/** maw workspace unshare <agent...> [--workspace <id>] */
export async function cmdWorkspaceUnshare(agents: string[], workspaceId?: string, deps: WorkspaceAgentsDeps = {}) {
  const d = workspaceAgentDeps(deps);
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

  d.log.log(`\x1b[36mremoving\x1b[0m ${agents.length} agent(s) from workspace "${ws.name}"...`);

  const config = d.loadConfig();
  const res = await d.curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/agents`, {
    method: "POST",
    body: JSON.stringify({ action: "unshare", agents, node: config.node ?? "local" }),
  });

  if (!res.ok) {
    d.log.error(`\x1b[31m\u274c\x1b[0m failed to unshare agents: ${res.data?.error || `HTTP ${res.status}`}`);
    d.exit(1);
  }

  // Update local config
  const removeSet = new Set(agents);
  ws.sharedAgents = ws.sharedAgents.filter(a => !removeSet.has(a));
  d.saveWorkspace(ws);

  d.log.log(`\x1b[32m\u2705\x1b[0m removed ${agents.length} agent(s)`);
  for (const a of agents) {
    d.log.log(`  \x1b[31m-\x1b[0m ${a}`);
  }
  d.log.log(`\x1b[90m  total shared: ${ws.sharedAgents.length}\x1b[0m`);
}

/** maw workspace agents [workspace-id] */
export async function cmdWorkspaceAgents(workspaceId?: string, deps: WorkspaceAgentsDeps = {}) {
  const d = workspaceAgentDeps(deps);
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

  d.log.log(`\x1b[36mfetching\x1b[0m agents for workspace "${ws.name}"...`);

  const res = await d.curlFetch(`${ws.hubUrl}/api/workspace/${ws.id}/agents`, { timeout: d.cfgTimeout("workspace") });

  if (!res.ok) {
    d.log.error(`\x1b[31m\u274c\x1b[0m failed to fetch agents: ${res.data?.error || `HTTP ${res.status}`}`);
    d.exit(1);
  }

  const nodes: Record<string, string[]> = res.data?.nodes || {};
  const nodeNames = Object.keys(nodes);

  if (nodeNames.length === 0) {
    d.log.log("\x1b[90mNo agents in workspace yet.\x1b[0m");
    d.log.log("\x1b[90m  maw workspace share <agent...>  Share your agents\x1b[0m");
    return;
  }

  d.log.log(`\n\x1b[36;1m${ws.name}\x1b[0m  \x1b[90mAgents by node\x1b[0m\n`);

  let totalAgents = 0;
  for (const node of nodeNames) {
    const agents = nodes[node] || [];
    totalAgents += agents.length;
    d.log.log(`  \x1b[37;1m${node}\x1b[0m  \x1b[90m(${agents.length} agent${agents.length !== 1 ? "s" : ""})\x1b[0m`);
    for (const a of agents) {
      d.log.log(`    \x1b[90m\u25cf\x1b[0m ${a}`);
    }
  }

  d.log.log(`\n\x1b[90m${totalAgents} total agents across ${nodeNames.length} node${nodeNames.length !== 1 ? "s" : ""}\x1b[0m\n`);
}
