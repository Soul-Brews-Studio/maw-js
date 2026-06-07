import type { HubConnection } from "./hub-connection";

export const REMOTE_AGENT_STALE_MS = 60 * 60 * 1000;

function lastSeen(conn: HubConnection): Map<string, number> {
  return conn.remoteAgentLastSeen ??= new Map();
}

function owners(conn: HubConnection): Map<string, string> {
  return conn.remoteAgentOwners ??= new Map();
}

export function rememberRemoteAgent(conn: HubConnection, name: string, seenAt = Date.now(), owner?: string): void {
  if (!name) return;
  conn.remoteAgents.add(name);
  lastSeen(conn).set(name, seenAt);
  if (owner) owners(conn).set(name, owner);
}

export function forgetRemoteAgent(conn: HubConnection, name: string): void {
  conn.remoteAgents.delete(name);
  conn.remoteAgentLastSeen?.delete(name);
  conn.remoteAgentOwners?.delete(name);
}

export function forgetRemoteAgentsForNode(conn: HubConnection, nodeId: string): string[] {
  const removed: string[] = [];
  for (const [agent, owner] of conn.remoteAgentOwners ?? []) {
    if (owner !== nodeId) continue;
    forgetRemoteAgent(conn, agent);
    removed.push(agent);
  }
  return removed;
}

export function clearRemoteAgents(conn: HubConnection): void {
  conn.remoteAgents.clear();
  conn.remoteAgentLastSeen?.clear();
  conn.remoteAgentOwners?.clear();
}

export function pruneStaleRemoteAgents(
  conn: HubConnection,
  now = Date.now(),
  maxAgeMs = REMOTE_AGENT_STALE_MS,
): string[] {
  const removed: string[] = [];
  for (const agent of Array.from(conn.remoteAgents)) {
    const seenAt = conn.remoteAgentLastSeen?.get(agent);
    if (seenAt === undefined || now - seenAt <= maxAgeMs) continue;
    forgetRemoteAgent(conn, agent);
    removed.push(agent);
  }
  return removed;
}
