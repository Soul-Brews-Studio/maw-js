/**
 * HTTP transport — fallback for peers[] federation.
 *
 * Wraps the existing peers.ts HTTP mechanism as a Transport interface.
 * This is the last resort when MQTT is unavailable.
 */

import { sendKeysToPeer, getAggregatedSessions } from "../core/transport/peers";
import { cfgTimeout } from "../config";
import { listSessions } from "../core/transport/ssh";
import { findWindow } from "../core/runtime/find-window";
import type { Session } from "../core/runtime/find-window";
import { curlFetch } from "../core/transport/curl-fetch";
import type { Transport, TransportTarget, TransportMessage, TransportPresence } from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";

export interface HttpTransportConfig {
  /** Peer URLs from maw.config.json peers[] */
  peers: string[];
  selfHost: string;
}

interface HttpTransportDeps {
  listLocalSessions?: typeof listSessions;
  getAllSessions?: typeof getAggregatedSessions;
  findTargetWindow?: (sessions: Session[], query: string) => string | null;
  sendPeerKeys?: typeof sendKeysToPeer;
  postPeerFeed?: typeof curlFetch;
  timeoutFor?: typeof cfgTimeout;
}

export class HttpTransport implements Transport {
  readonly name = "http-federation";
  private _connected = false;
  private config: HttpTransportConfig;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(
    config: HttpTransportConfig,
    private readonly deps: HttpTransportDeps = {},
  ) {
    this.config = config;
  }

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    this._connected = this.config.peers.length > 0;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    // Find which peer has this target
    const localSessions = await (this.deps.listLocalSessions ?? listSessions)();
    const allSessions = await (this.deps.getAllSessions ?? getAggregatedSessions)(localSessions);

    for (const session of allSessions) {
      const source = (session as any).source;
      if (!source || source === "local") continue;

      const match = session.windows.some((w) => w.name.toLowerCase().includes(target.oracle.toLowerCase()));
      if (match) {
        const tmuxTarget = (this.deps.findTargetWindow ?? findWindow)([session], target.oracle);
        if (tmuxTarget) {
          return (this.deps.sendPeerKeys ?? sendKeysToPeer)(source, tmuxTarget, message);
        }
      }
    }

    return false;
  }

  async publishPresence(_presence: TransportPresence): Promise<void> {
    // HTTP federation doesn't support real-time presence — polling only
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    // Post feed event to all peers via curlFetch (bypasses macOS Local Network Privacy).
    // Per-peer failures are best-effort but must be visible: allSettled collects
    // rejections so we can warn per failed peer (#385 site 4 — previously double-buried
    // by an inner trySilentAsync inside allSettled, which made cluster-wide drops silent).
    const peers = this.config.peers;
    const postFeed = this.deps.postPeerFeed ?? curlFetch;
    const results = await Promise.allSettled(
      peers.map((url) => postFeed(`${url}/api/feed`, {
        method: "POST",
        body: JSON.stringify(event),
        timeout: (this.deps.timeoutFor ?? cfgTimeout)("http"),
      })),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`\x1b[33m⚠\x1b[0m feed publish failed for ${peers[i]}: ${reason}`);
      }
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

  /** HTTP federation can reach targets on configured peers */
  canReach(target: TransportTarget): boolean {
    if (!target.host || target.host === "local" || target.host === "localhost") return false;
    // Can reach if we have any peers configured
    return this.config.peers.length > 0;
  }
}
