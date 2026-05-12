/**
 * Scout transport — zenoh-inspired zero-config LAN discovery + auto-pairing.
 *
 * Replaces MdnsTransport with a proper Scout→Hello→Pair handshake:
 *   1. Scout (multicast) — "who's out there?"
 *   2. Hello (unicast)   — "I'm here, these are my capabilities"
 *   3. Pair  (HTTP)      — "let's establish a persistent peer relationship"
 *
 * Backward-compatible: accepts maw-announce from legacy MdnsTransport nodes.
 */

import { createSocket, type Socket } from "dgram";
import type {
  Transport,
  TransportTarget,
  TransportMessage,
  TransportPresence,
  MessageHandler,
  PresenceHandler,
  FeedHandler,
} from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";
import { loadPeers } from "../lib/peers/store";
import {
  MULTICAST_ADDR,
  MULTICAST_PORT,
  generateZid,
  makeScout,
  makeHello,
  parseMessage,
  type HelloMessage,
} from "./scout-protocol";
import { ScoutState } from "./scout-state";
import { initiatePair } from "./scout-pair";
import { recordHelloZid } from "../api/pair";

export interface ScoutTransportConfig {
  node: string;
  oracle?: string;
  port: number;
  oracles?: string[];
  autoPair?: boolean;
}

// ─── Module-level singleton for cross-module access (#1237) ────────────────
// The API layer (src/api/pair.ts) needs to read live `discoveredPeers` for
// `GET /api/peers/discoveries`. Rather than inject the router into Elysia we
// expose the *last connected* ScoutTransport via a small accessor. Tests can
// override with `_setCurrentScout(null)` to clear.
let currentScout: ScoutTransport | null = null;
export function getCurrentScout(): ScoutTransport | null {
  return currentScout;
}
export function _setCurrentScout(s: ScoutTransport | null): void {
  currentScout = s;
}

export class ScoutTransport implements Transport {
  readonly name = "scout-p2p";
  private _connected = false;
  private config: ScoutTransportConfig;
  private socket: Socket | null = null;
  private scoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private state: ScoutState;
  private msgHandlers = new Set<MessageHandler>();
  private presenceHandlers = new Set<PresenceHandler>();
  private feedHandlers = new Set<FeedHandler>();

  constructor(config: ScoutTransportConfig) {
    this.config = config;
    this.state = new ScoutState(generateZid());
  }

  get connected() {
    return this._connected;
  }

  async connect(): Promise<void> {
    try {
      this.loadExistingPeers();

      this.socket = createSocket({ type: "udp4", reuseAddr: true });

      this.socket.on("message", (buf, rinfo) => {
        const msg = parseMessage(buf);
        if (!msg) return;

        switch (msg.type) {
          case "maw-scout":
            this.handleScout(msg, rinfo.address, rinfo.port);
            break;
          case "maw-hello":
            this.handleHello(msg, rinfo.address);
            break;
          case "maw-announce":
            this.handleLegacyAnnounce(msg, rinfo.address);
            break;
        }
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
      currentScout = this; // #1237 — make this instance reachable from the API layer
      this.scheduleScout();
      this.pruneTimer = setInterval(() => this.pruneStale(), 10_000);

      console.log(
        `[scout] listening on ${MULTICAST_ADDR}:${MULTICAST_PORT} as ${this.config.node} (zid: ${this.state.localZid.slice(0, 8)}…)`,
      );
    } catch (err) {
      console.warn(
        `[scout] connect failed: ${err instanceof Error ? err.message : err}`,
      );
      this._connected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.scoutTimer) {
      clearTimeout(this.scoutTimer);
      this.scoutTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.dropMembership(MULTICAST_ADDR);
      } catch {}
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
    if (currentScout === this) currentScout = null;
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    const peer = this.findPeer(target);
    if (!peer) return false;

    const url = peer.locators[0];
    if (!url) return false;

    try {
      const res = await fetch(`${url}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: target.oracle, text: message }),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        if (data.ok) {
          const msg: TransportMessage = {
            from: this.config.node,
            to: target.oracle,
            body: message,
            timestamp: Date.now(),
            transport: "scout" as const,
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

  async publishPresence(_presence: TransportPresence): Promise<void> {
    this.sendScout();
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    for (const peer of this.state.discoveredPeers.values()) {
      const url = peer.locators[0];
      if (!url) continue;
      fetch(`${url}/api/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
  }

  onMessage(handler: MessageHandler) {
    this.msgHandlers.add(handler);
  }

  onPresence(handler: PresenceHandler) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: FeedHandler) {
    this.feedHandlers.add(handler);
  }

  canReach(target: TransportTarget): boolean {
    if (!target.host || target.host === "local" || target.host === "localhost")
      return false;
    return this.findPeer(target) !== null;
  }

  listPeers() {
    return [...this.state.discoveredPeers.values()];
  }

  /**
   * Snapshot of discovered peers as plain objects — for HTTP exposure (#1237).
   * Returned in `lastSeen` desc order. Re-syncs `paired` against the latest
   * peers.json so a peer added via `peers accept` flips ✓ without waiting
   * for the next Hello.
   */
  discoveriesSnapshot(): import("./scout-state").DiscoveredPeer[] {
    // Refresh `paired` from on-disk peers.json — cheap (small JSON) and keeps
    // the snapshot honest immediately after an accept.
    try {
      const { peers } = loadPeers();
      const pairedNodes = new Set<string>();
      for (const [, p] of Object.entries(peers)) {
        if (p.node) pairedNodes.add(p.node);
      }
      for (const peer of this.state.discoveredPeers.values()) {
        if (!peer.paired && pairedNodes.has(peer.node)) peer.paired = true;
      }
    } catch { /* ignore — best-effort refresh */ }

    return [...this.state.discoveredPeers.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  // ─── Protocol Handlers ─────────────────────────────────────────────

  private handleScout(
    msg: { zid: string; whatAmI: string },
    fromHost: string,
    fromPort: number,
  ): void {
    if (msg.zid === this.state.localZid) return;

    const hello = makeHello({
      zid: this.state.localZid,
      node: this.config.node,
      oracle: this.config.oracle ?? this.config.node,
      locators: [`http://${this.config.node}:${this.config.port}`],
      oracles: this.config.oracles,
    });

    const buf = Buffer.from(JSON.stringify(hello));
    this.socket?.send(buf, fromPort, fromHost);
  }

  private handleHello(hello: HelloMessage, fromHost: string): void {
    recordHelloZid(hello.zid);
    const { isNew, shouldPair } = this.state.handleHello(hello, fromHost);

    if (isNew) {
      console.log(
        `[scout] discovered: ${hello.node} at ${fromHost} (zid: ${hello.zid.slice(0, 8)}…, oracles: ${hello.oracles.length})`,
      );
    }

    this.emitPresence(hello.node, fromHost, "ready");

    if (shouldPair && this.config.autoPair !== false) {
      this.state.markPending(hello.zid);
      this.doPair(hello.zid);
    }
  }

  private handleLegacyAnnounce(
    msg: { node: string; port: number; oracles: string[] },
    fromHost: string,
  ): void {
    if (msg.node === this.config.node) return;

    const legacyHello: HelloMessage = {
      type: "maw-hello",
      version: 1,
      zid: `legacy-${msg.node}`,
      whatAmI: "oracle",
      node: msg.node,
      oracle: msg.node,
      locators: [`http://${fromHost}:${msg.port || 3456}`],
      capabilities: [],
      oracles: msg.oracles || [],
      ts: Date.now(),
    };

    const existing = this.state.findPeerByNode(msg.node);
    if (!existing) {
      console.log(
        `[scout] legacy peer: ${msg.node} at ${fromHost}:${msg.port}`,
      );
    }

    this.state.handleHello(legacyHello, fromHost);
    this.emitPresence(msg.node, fromHost, "ready");
  }

  // ─── Scout Loop ────────────────────────────────────────────────────

  private scheduleScout(): void {
    if (!this._connected) return;
    const delay = this.state.advanceBackoff();
    this.scoutTimer = setTimeout(() => {
      this.sendScout();
      this.scheduleScout();
    }, delay);
  }

  private sendScout(): void {
    if (!this.socket || !this._connected) return;
    const msg = makeScout(this.state.localZid);
    const buf = Buffer.from(JSON.stringify(msg));
    this.socket.send(buf, MULTICAST_PORT, MULTICAST_ADDR);
  }

  // ─── Pairing ───────────────────────────────────────────────────────

  private async doPair(zid: string): Promise<void> {
    const peer = this.state.findPeerByZid(zid);
    if (!peer) {
      this.state.clearPending(zid);
      return;
    }

    console.log(`[scout] pairing with ${peer.node} (zid: ${zid.slice(0, 8)}…)…`);

    const result = await initiatePair(
      peer,
      this.config.node,
      this.config.oracle ?? this.config.node,
      this.config.port,
    );

    if (result.ok) {
      this.state.markPaired(zid);
      console.log(`[scout] ✓ paired with ${peer.node}`);
    } else {
      this.state.clearPending(zid);
      console.warn(`[scout] pair failed with ${peer.node}: ${result.error}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private findPeer(target: TransportTarget) {
    if (target.host) {
      const p = this.state.findPeerByNode(target.host);
      if (p) return p;
    }
    return this.state.findPeerByOracle(target.oracle);
  }

  private emitPresence(oracle: string, host: string, status: TransportPresence["status"]): void {
    for (const h of this.presenceHandlers) {
      h({ oracle, host, status, timestamp: Date.now() });
    }
  }

  private pruneStale(): void {
    const removed = this.state.pruneStale();
    for (const node of removed) {
      console.log(`[scout] peer gone: ${node}`);
      this.emitPresence(node, "", "offline");
    }
  }

  private loadExistingPeers(): void {
    try {
      const { peers } = loadPeers();
      for (const [alias] of Object.entries(peers)) {
        this.state.markExistingPeerPaired(alias);
      }
    } catch {}
  }
}
