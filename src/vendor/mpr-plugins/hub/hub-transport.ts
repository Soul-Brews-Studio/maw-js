/**
 * HubTransport — WebSocket client connecting private nodes to a workspace hub.
 * See hub.ts for full protocol documentation.
 */

import type { Transport, TransportTarget, TransportMessage, TransportPresence } from "../../../core/transport/transport";
import type { FeedEvent } from "../../../lib/feed";
import { loadConfig } from "../../../config";
import { trySilent } from "../../../core/util/try-silent";
import type { HubConnection } from "./hub-connection";
import { cleanupConnection, openWebSocket } from "./hub-connection";
import { REMOTE_AGENT_STALE_MS, pruneStaleRemoteAgents } from "./hub-agent-registry";
import { loadWorkspaceConfigs } from "./hub-config";
import type { WorkspaceConfig } from "./hub-config";

interface HubTransportDeps {
  loadConfig?: typeof loadConfig;
  loadWorkspaces?: typeof loadWorkspaceConfigs;
  openSocket?: typeof openWebSocket;
  cleanup?: typeof cleanupConnection;
  setConnectTimeout?: typeof setTimeout;
  clearConnectTimeout?: typeof clearTimeout;
  setReconcileInterval?: typeof setInterval;
  clearReconcileInterval?: typeof clearInterval;
  now?: () => number;
  remoteAgentStaleMs?: number;
}

export class HubTransport implements Transport {
  readonly name = "workspace-hub";
  readonly priority = 30;  // between MQTT (20) and HTTP (40)
  private _connected = false;
  private connections: Map<string, HubConnection> = new Map();
  private nodeId: string;
  private federationToken: string | undefined;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    nodeId?: string,
    private readonly deps: HubTransportDeps = {},
  ) {
    const config = (this.deps.loadConfig ?? loadConfig)();
    this.nodeId = nodeId ?? config.node ?? "local";
    this.federationToken = config.federationToken;
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    const workspaces = (this.deps.loadWorkspaces ?? loadWorkspaceConfigs)();
    if (workspaces.length === 0) {
      console.log("[hub] no workspace configs found");
      return;
    }

    console.log(`[hub] connecting to ${workspaces.length} workspace(s)...`);

    const results = await Promise.allSettled(
      workspaces.map((ws) => this.connectWorkspace(ws)),
    );

    // Connected if at least one workspace succeeded
    const anyConnected = results.some(
      (r) => r.status === "fulfilled" && r.value === true,
    );
    this._connected = anyConnected;
    if (anyConnected) this.startRemoteAgentReconciliation();
  }

  async disconnect(): Promise<void> {
    this.stopRemoteAgentReconciliation();
    for (const conn of this.connections.values()) {
      (this.deps.cleanup ?? cleanupConnection)(conn);
    }
    this.connections.clear();
    this._connected = false;
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    const qualifiedTarget = target.host
      ? `${target.host}:${target.oracle}`
      : target.oracle;

    // Find a workspace that can reach this target
    for (const conn of this.connections.values()) {
      if (!conn.connected || !conn.ws) continue;

      // Check if this workspace knows about the target agent
      if (conn.remoteAgents.has(target.oracle) || conn.remoteAgents.has(qualifiedTarget)) {
        const payload = JSON.stringify({
          type: "message",
          to: qualifiedTarget,
          body: message,
          from: `${this.nodeId}:${target.oracle}`,
          timestamp: Date.now(),
        });

        try {
          conn.ws.send(payload);
          return true;
        } catch (err) {
          console.warn(`[hub] send failed on workspace ${conn.config.id}:`, err);
        }
      }
    }

    return false;
  }

  async publishPresence(presence: TransportPresence): Promise<void> {
    const payload = JSON.stringify({
      type: "presence",
      agents: [{ name: presence.oracle, status: presence.status }],
      timestamp: presence.timestamp,
    });

    for (const conn of this.connections.values()) {
      if (!conn.connected || !conn.ws) continue;
      // Best effort — don't break on single workspace failure
      trySilent(() => conn.ws?.send(payload));
    }
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    const payload = JSON.stringify({ type: "feed", event });

    for (const conn of this.connections.values()) {
      if (!conn.connected || !conn.ws) continue;
      // Best effort
      trySilent(() => conn.ws?.send(payload));
    }
  }

  onMessage(handler: (msg: TransportMessage) => void) {
    this.msgHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  /** Can reach any agent visible in any joined workspace */
  canReach(target: TransportTarget): boolean {
    if (!this._connected) return false;
    const qualifiedTarget = target.host
      ? `${target.host}:${target.oracle}`
      : target.oracle;

    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      if (conn.remoteAgents.has(target.oracle) || conn.remoteAgents.has(qualifiedTarget)) {
        return true;
      }
    }
    return false;
  }

  /** Get status of all workspace connections */
  workspaceStatus(): { id: string; connected: boolean; remoteAgents: string[] }[] {
    return Array.from(this.connections.values()).map((conn) => ({
      id: conn.config.id,
      connected: conn.connected,
      remoteAgents: Array.from(conn.remoteAgents),
    }));
  }

  // --- Private ---

  private connectWorkspace(config: WorkspaceConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const conn: HubConnection = {
        config,
        ws: null,
        connected: false,
        heartbeatTimer: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        remoteAgents: new Set(),
      };

      this.connections.set(config.id, conn);
      const timeout = (this.deps.setConnectTimeout ?? setTimeout)(() => {
        if (!conn.connected) {
          console.warn(`[hub] workspace ${config.id}: connection timeout`);
          resolve(false);
        }
      }, 10_000);

      (this.deps.openSocket ?? openWebSocket)(
        conn,
        this.nodeId,
        this.federationToken,
        this.msgHandlers,
        this.presenceHandlers,
        this.feedHandlers,
        () => {
          this._connected = true;
          this.startRemoteAgentReconciliation();
        },
        () => this.updateConnectedState(),
        () => { (this.deps.clearConnectTimeout ?? clearTimeout)(timeout); resolve(true); },
      );
    });
  }

  private updateConnectedState() {
    this._connected = Array.from(this.connections.values()).some((c) => c.connected);
    if (this._connected) this.startRemoteAgentReconciliation();
    else this.stopRemoteAgentReconciliation();
  }

  private startRemoteAgentReconciliation() {
    if (this.reconcileTimer) return;
    const setTimer = this.deps.setReconcileInterval ?? setInterval;
    this.reconcileTimer = setTimer(() => this.pruneStaleRemoteAgents(), 5 * 60 * 1000);
    (this.reconcileTimer as any)?.unref?.();
  }

  private stopRemoteAgentReconciliation() {
    if (!this.reconcileTimer) return;
    (this.deps.clearReconcileInterval ?? clearInterval)(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private pruneStaleRemoteAgents() {
    const now = (this.deps.now ?? Date.now)();
    const staleMs = this.deps.remoteAgentStaleMs ?? REMOTE_AGENT_STALE_MS;
    for (const conn of this.connections.values()) {
      const removed = pruneStaleRemoteAgents(conn, now, staleMs);
      if (removed.length > 0) {
        console.log(`[hub] workspace ${conn.config.id}: pruned stale remote agent(s): ${removed.join(", ")}`);
      }
    }
  }
}
