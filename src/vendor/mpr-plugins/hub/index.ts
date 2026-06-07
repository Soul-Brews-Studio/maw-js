/**
 * Hub transport — WebSocket client connecting private nodes to a workspace hub.
 *
 * Private nodes use this to:
 *   - Register shared agents with the hub
 *   - Send/receive messages routed through the hub
 *   - Forward feed events and presence updates
 *   - Receive messages destined for local agents
 *
 * Config loaded from ~/.config/maw/workspaces/*.json:
 *   { id, hubUrl, token, sharedAgents }
 *
 * Opens one WebSocket per workspace. Reconnects automatically on disconnect.
 *
 * Protocol (Node → Hub):
 *   { type: "auth", token: "wst_...", nodeId: "white", sig, ts }
 *   { type: "heartbeat", timestamp }
 *   { type: "presence", agents: [{name, status}...] }
 *   { type: "feed", event: {...FeedEvent} }
 *   { type: "message", to: "mba:homekeeper", body, from: "white:neo" }
 *
 * Protocol (Hub → Node):
 *   { type: "auth-ok", workspaceId, agents: [...] }
 *   { type: "message", from, to, body }
 *   { type: "presence", agents: [...] }
 *   { type: "node-joined", nodeId }
 */

export type { WorkspaceConfig } from "./hub-config";
import { loadWorkspaceConfigs } from "./hub-config";
import { HubTransport } from "./hub-transport";
export { loadWorkspaceConfigs, HubTransport };

import type { MawConfig } from "../../../config/types";
import type { Transport, TransportRouter } from "../../../core/transport/transport";

type TransportHookContext = {
  config?: MawConfig;
  register?: (transport: Transport) => void;
  router?: Pick<TransportRouter, "register">;
};

export function createHubTransport(config?: Pick<MawConfig, "node">): Transport | null {
  if (loadWorkspaceConfigs().length === 0) return null;
  return new HubTransport(config?.node);
}

export async function transport(ctx: TransportHookContext = {}): Promise<{ ok: true; registered: string[] }> {
  const hub = createHubTransport(ctx.config);
  if (!hub) return { ok: true, registered: [] };
  if (ctx.register) ctx.register(hub);
  else ctx.router?.register(hub);
  return { ok: true, registered: [hub.name] };
}
