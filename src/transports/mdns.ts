/**
 * mDNS discovery + direct P2P transport.
 *
 * Broadcasts presence via multicast UDP (224.0.0.251:5353-style) and
 * discovers peers on the LAN automatically. Messages go direct HTTP
 * to the discovered peer's /api/send — no central router needed.
 *
 * Discovery protocol:
 *   Multicast group: 224.0.0.224 port 31746 (same as zenoh default)
 *   Announce: { type: "maw-announce", node, port, oracles[] }
 *   Every 10s heartbeat + immediate on connect
 *
 * DM flow:
 *   1. Discover peer via multicast → learn its IP:port
 *   2. POST /api/send directly → peer delivers to local tmux
 */

import { createSocket, type Socket } from "dgram";
import type {
  Transport,
  TransportTarget,
  TransportMessage,
  TransportPresence,
} from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";

const MULTICAST_ADDR = "224.0.0.224";
const MULTICAST_PORT = 31746;
const HEARTBEAT_MS = 10_000;

export interface MdnsTransportConfig {
  node: string;
  port: number;
  oracles?: string[];
}

interface DiscoveredPeer {
  node: string;
  host: string;
  port: number;
  oracles: string[];
  lastSeen: number;
}

export class MdnsTransport implements Transport {
  readonly name = "mdns-p2p";
  private _connected = false;
  private config: MdnsTransportConfig;
  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private peers = new Map<string, DiscoveredPeer>();
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(config: MdnsTransportConfig) {
    this.config = config;
  }

  get connected() {
    return this._connected;
  }

  async connect(): Promise<void> {
    try {
      this.socket = createSocket({ type: "udp4", reuseAddr: true });

      this.socket.on("message", (buf, rinfo) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg.type === "maw-announce" && msg.node !== this.config.node) {
            const peer: DiscoveredPeer = {
              node: msg.node,
              host: rinfo.address,
              port: msg.port || 3456,
              oracles: msg.oracles || [],
              lastSeen: Date.now(),
            };
            const isNew = !this.peers.has(msg.node);
            this.peers.set(msg.node, peer);

            if (isNew) {
              console.log(
                `[mdns] discovered: ${msg.node} at ${rinfo.address}:${peer.port} (${peer.oracles.length} oracles)`,
              );
            }

            for (const h of this.presenceHandlers) {
              h({
                oracle: msg.node,
                host: rinfo.address,
                status: "ready",
                timestamp: Date.now(),
              });
            }
          }
        } catch {}
      });

      await new Promise<void>((resolve, reject) => {
        this.socket!.bind(MULTICAST_PORT, () => {
          try {
            this.socket!.addMembership(MULTICAST_ADDR);
            this.socket!.setMulticastTTL(2);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        this.socket!.on("error", reject);
      });

      this._connected = true;
      this.announce();
      this.heartbeatTimer = setInterval(() => {
        this.announce();
        this.pruneStale();
      }, HEARTBEAT_MS);

      console.log(
        `[mdns] listening on ${MULTICAST_ADDR}:${MULTICAST_PORT} as ${this.config.node}`,
      );
    } catch (err) {
      console.warn(
        `[mdns] connect failed: ${err instanceof Error ? err.message : err}`,
      );
      this._connected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.dropMembership(MULTICAST_ADDR);
      } catch {}
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
    this.peers.clear();
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    const peer = this.findPeer(target);
    if (!peer) return false;

    try {
      const url = `http://${peer.host}:${peer.port}/api/send`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: target.oracle,
          text: message,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.ok) {
          const msg: TransportMessage = {
            from: this.config.node,
            to: target.oracle,
            body: message,
            timestamp: Date.now(),
            transport: "http" as any,
          };
          for (const h of this.msgHandlers) h(msg);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async publishPresence(presence: TransportPresence): Promise<void> {
    this.announce();
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    // Broadcast feed to all discovered peers
    for (const peer of this.peers.values()) {
      try {
        fetch(`http://${peer.host}:${peer.port}/api/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      } catch {}
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

  canReach(target: TransportTarget): boolean {
    if (!target.host || target.host === "local" || target.host === "localhost")
      return false;
    return this.findPeer(target) !== null;
  }

  /** List discovered peers */
  listPeers(): DiscoveredPeer[] {
    return [...this.peers.values()];
  }

  // ─── Private ──────────────────────────────────────────────────────

  private findPeer(target: TransportTarget): DiscoveredPeer | null {
    // Match by node name
    if (target.host && this.peers.has(target.host)) {
      return this.peers.get(target.host)!;
    }
    // Match by oracle name across all peers
    for (const peer of this.peers.values()) {
      if (peer.oracles.some((o) => o.includes(target.oracle))) {
        return peer;
      }
    }
    return null;
  }

  private announce() {
    if (!this.socket || !this._connected) return;
    const msg = JSON.stringify({
      type: "maw-announce",
      node: this.config.node,
      port: this.config.port,
      oracles: this.config.oracles || [],
      ts: Date.now(),
    });
    this.socket.send(msg, MULTICAST_PORT, MULTICAST_ADDR);
  }

  private pruneStale() {
    const cutoff = Date.now() - HEARTBEAT_MS * 3;
    for (const [node, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        console.log(`[mdns] peer gone: ${node}`);
        this.peers.delete(node);
        for (const h of this.presenceHandlers) {
          h({
            oracle: node,
            host: peer.host,
            status: "offline",
            timestamp: Date.now(),
          });
        }
      }
    }
  }
}
