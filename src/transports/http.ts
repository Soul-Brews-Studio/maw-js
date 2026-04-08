/**
 * HTTP transport — fallback for peers[] federation.
 *
 * Wraps the existing peers.ts HTTP mechanism as a Transport interface.
 * This is the last resort when MQTT is unavailable.
 */

import { sendKeysToPeer, getAggregatedSessions } from "../peers";
import { cfgTimeout } from "../config";
import { listSessions } from "../ssh";
import { findWindow } from "../find-window";
import { curlFetch } from "../curl-fetch";
import type { Transport, TransportTarget, TransportMessage, TransportPresence } from "../transport";
import type { FeedEvent } from "../lib/feed";

export interface HttpTransportConfig {
  /** Peer URLs from maw.config.json peers[] */
  peers: string[];
  selfHost: string;
}

export class HttpTransport implements Transport {
  readonly name = "http-federation";
  private _connected = false;
  private config: HttpTransportConfig;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(config: HttpTransportConfig) {
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
    const localSessions = await listSessions();
    const allSessions = await getAggregatedSessions(localSessions);

    for (const session of allSessions) {
      const source = (session as any).source;
      if (!source || source === "local") continue;

      const match = session.windows.some((w) => w.name.toLowerCase().includes(target.oracle.toLowerCase()));
      if (match) {
        const tmuxTarget = findWindow([session], target.oracle);
        if (tmuxTarget) {
          return sendKeysToPeer(source, tmuxTarget, message);
        }
      }
    }

    return false;
  }

  async publishPresence(_presence: TransportPresence): Promise<void> {
    // HTTP federation doesn't support real-time presence — polling only
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    // Post feed event to all peers via curlFetch (bypasses macOS Local Network Privacy)
    await Promise.allSettled(
      this.config.peers.map(async (url) => {
        try {
          await curlFetch(`${url}/api/feed`, {
            method: "POST",
            body: JSON.stringify(event),
            timeout: cfgTimeout("http"),
          });
        } catch {}
      }),
    );
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
