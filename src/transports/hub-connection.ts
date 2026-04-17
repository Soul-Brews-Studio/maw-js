/**
 * Hub connection lifecycle — standalone functions operating on HubConnection.
 * Imported by hub-transport.ts; separated to keep per-file LOC under 200.
 */

import type { TransportMessage, TransportPresence } from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";
import { sign } from "../lib/federation-auth";
import { trySilent } from "../core/util/try-silent";
import { sanitizeLogField } from "../core/util/sanitize-log";
import { HEARTBEAT_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "./hub-config";
import type { WorkspaceConfig } from "./hub-config";

/** Live connection to a single workspace hub */
export interface HubConnection {
  config: WorkspaceConfig;
  ws: WebSocket | null;
  connected: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** Remote agents visible through this workspace (from auth-ok + presence) */
  remoteAgents: Set<string>;
}

export function sendAuth(conn: HubConnection, nodeId: string, federationToken: string | undefined): void {
  if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
  const ts = Math.floor(Date.now() / 1000);
  const authPayload: Record<string, any> = {
    type: "auth",
    token: conn.config.token,
    nodeId,
    sharedAgents: conn.config.sharedAgents,
    timestamp: ts,
  };
  if (federationToken) {
    authPayload._ts = ts;
    authPayload._sig = sign(federationToken, "WS", `auth:${conn.config.id}`, ts);
  }
  conn.ws.send(JSON.stringify(authPayload));
}

export function handleMessage(
  conn: HubConnection,
  raw: string,
  msgHandlers: Set<(msg: TransportMessage) => void>,
  presenceHandlers: Set<(p: TransportPresence) => void>,
  feedHandlers: Set<(e: FeedEvent) => void>,
): void {
  try {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case "auth-ok":
        // msg.workspaceId is attacker-influenced (parsed from WS frame).
        // Sanitize before logging to close CodeQL js/log-injection (#474).
        console.log(`[hub] workspace ${conn.config.id}: authenticated (workspace=${sanitizeLogField(msg.workspaceId)})`);
        if (Array.isArray(msg.agents)) conn.remoteAgents = new Set(msg.agents);
        break;
      case "message": {
        const transportMsg: TransportMessage = {
          from: msg.from || "unknown",
          to: msg.to || "unknown",
          body: msg.body || "",
          timestamp: msg.timestamp || Date.now(),
          transport: "hub",
        };
        for (const h of msgHandlers) h(transportMsg);
        break;
      }
      case "presence":
        if (Array.isArray(msg.agents)) {
          for (const agent of msg.agents) {
            if (agent.name) conn.remoteAgents.add(agent.name);
            const presence: TransportPresence = {
              oracle: agent.name || "unknown",
              host: agent.host || agent.nodeId || "remote",
              status: agent.status || "ready",
              timestamp: msg.timestamp || Date.now(),
            };
            for (const h of presenceHandlers) h(presence);
          }
        }
        break;
      case "node-joined":
        // msg.nodeId is attacker-influenced — sanitize before logging.
        console.log(`[hub] workspace ${conn.config.id}: node joined — ${sanitizeLogField(msg.nodeId)}`);
        break;
      case "node-left":
        // msg.nodeId is attacker-influenced — sanitize before logging.
        console.log(`[hub] workspace ${conn.config.id}: node left — ${sanitizeLogField(msg.nodeId)}`);
        if (msg.agents && Array.isArray(msg.agents)) {
          for (const agent of msg.agents) conn.remoteAgents.delete(agent);
        }
        break;
      case "feed":
        if (msg.event) for (const h of feedHandlers) h(msg.event);
        break;
      case "error":
        // Both msg.message and msg.reason are attacker-influenced — sanitize.
        console.error(`[hub] workspace ${conn.config.id}: hub error — ${sanitizeLogField(msg.message || msg.reason)}`);
        break;
      default:
        break;
    }
  } catch {
    // Malformed JSON — ignore
  }
}

export function startHeartbeat(conn: HubConnection, nodeId: string): void {
  stopHeartbeat(conn);
  conn.heartbeatTimer = setInterval(() => {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now(), nodeId }));
    }
  }, HEARTBEAT_MS);
}

export function stopHeartbeat(conn: HubConnection): void {
  if (conn.heartbeatTimer) {
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = null;
  }
}

export function scheduleReconnect(conn: HubConnection, doOpen: () => void): void {
  if (conn.reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, conn.reconnectAttempt),
    RECONNECT_MAX_MS,
  );
  conn.reconnectAttempt++;
  console.log(`[hub] workspace ${conn.config.id}: reconnecting in ${Math.round(delay / 1000)}s (attempt ${conn.reconnectAttempt})`);

  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    if (conn.ws) {
      trySilent(() => conn.ws?.close());
    }
    doOpen();
  }, delay);
}

export function cleanupConnection(conn: HubConnection): void {
  stopHeartbeat(conn);
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
  if (conn.ws) {
    trySilent(() => conn.ws?.close(1000, "transport disconnect"));
    conn.ws = null;
  }
  conn.connected = false;
}

export function openWebSocket(
  conn: HubConnection,
  nodeId: string,
  federationToken: string | undefined,
  msgHandlers: Set<(msg: TransportMessage) => void>,
  presenceHandlers: Set<(p: TransportPresence) => void>,
  feedHandlers: Set<(e: FeedEvent) => void>,
  onSetConnected: () => void,
  onUpdateState: () => void,
  onFirstConnect?: () => void,
): void {
  const reopen = () => openWebSocket(conn, nodeId, federationToken, msgHandlers, presenceHandlers, feedHandlers, onSetConnected, onUpdateState);
  try {
    const ws = new WebSocket(conn.config.hubUrl);
    conn.ws = ws;

    ws.addEventListener("open", () => {
      console.log(`[hub] workspace ${conn.config.id}: connected to ${conn.config.hubUrl}`);
      conn.connected = true;
      conn.reconnectAttempt = 0;
      onSetConnected();
      sendAuth(conn, nodeId, federationToken);
      startHeartbeat(conn, nodeId);
      onFirstConnect?.();
    });

    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      handleMessage(conn, data, msgHandlers, presenceHandlers, feedHandlers);
    });

    ws.addEventListener("close", (event) => {
      console.log(`[hub] workspace ${conn.config.id}: disconnected (code=${event.code}, reason=${event.reason})`);
      conn.connected = false;
      stopHeartbeat(conn);
      onUpdateState();
      scheduleReconnect(conn, reopen);
    });

    ws.addEventListener("error", (event) => {
      console.error(`[hub] workspace ${conn.config.id}: error:`, (event as any).message || "connection error");
      // close event will fire after error — reconnect handled there
    });
  } catch (err) {
    console.error(`[hub] workspace ${conn.config.id}: failed to create WebSocket:`, err);
    scheduleReconnect(conn, reopen);
  }
}
