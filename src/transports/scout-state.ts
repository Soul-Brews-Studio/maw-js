/**
 * Scout state machine — backoff, peer tracking, GreaterZid dedup.
 */

import { greaterZid, type HelloMessage } from "./scout-protocol";

export const SCOUT_INITIAL_MS = 1_000;
export const SCOUT_MAX_MS = 8_000;
export const PEER_STALE_MS = 30_000;

export interface DiscoveredPeer {
  zid: string;
  node: string;
  host: string;
  oracle: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  /** Epoch-ms when this zid was first observed (set on insert, never updated). #1237 */
  firstSeen: number;
  lastSeen: number;
  paired: boolean;
}

export class ScoutState {
  readonly localZid: string;
  private _backoffMs = SCOUT_INITIAL_MS;
  readonly discoveredPeers = new Map<string, DiscoveredPeer>();
  readonly pendingConnections = new Set<string>();

  constructor(localZid: string) {
    this.localZid = localZid;
  }

  get backoffMs(): number {
    return this._backoffMs;
  }

  advanceBackoff(): number {
    const current = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 2, SCOUT_MAX_MS);
    return current;
  }

  resetBackoff(): void {
    this._backoffMs = SCOUT_INITIAL_MS;
  }

  handleHello(hello: HelloMessage, host: string): { isNew: boolean; shouldPair: boolean } {
    if (hello.zid === this.localZid) return { isNew: false, shouldPair: false };

    const existing = this.discoveredPeers.get(hello.zid);
    const isNew = !existing;
    const now = Date.now();

    this.discoveredPeers.set(hello.zid, {
      zid: hello.zid,
      node: hello.node,
      host,
      oracle: hello.oracle,
      locators: hello.locators,
      capabilities: hello.capabilities,
      oracles: hello.oracles,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      paired: existing?.paired ?? false,
    });

    if (isNew) this.resetBackoff();

    const alreadyPaired = existing?.paired ?? false;
    const isPending = this.pendingConnections.has(hello.zid);
    const shouldPair =
      isNew &&
      !alreadyPaired &&
      !isPending &&
      hello.capabilities.includes("pair") &&
      greaterZid(this.localZid, hello.zid);

    return { isNew, shouldPair };
  }

  markPaired(zid: string): void {
    const peer = this.discoveredPeers.get(zid);
    if (peer) peer.paired = true;
    this.pendingConnections.delete(zid);
  }

  markPending(zid: string): void {
    this.pendingConnections.add(zid);
  }

  clearPending(zid: string): void {
    this.pendingConnections.delete(zid);
  }

  markExistingPeerPaired(node: string): void {
    for (const peer of this.discoveredPeers.values()) {
      if (peer.node === node) peer.paired = true;
    }
  }

  pruneStale(): string[] {
    const cutoff = Date.now() - PEER_STALE_MS;
    const removed: string[] = [];
    for (const [zid, peer] of this.discoveredPeers) {
      if (peer.lastSeen < cutoff) {
        this.discoveredPeers.delete(zid);
        this.pendingConnections.delete(zid);
        removed.push(peer.node);
      }
    }
    return removed;
  }

  findPeerByNode(node: string): DiscoveredPeer | undefined {
    for (const peer of this.discoveredPeers.values()) {
      if (peer.node === node) return peer;
    }
    return undefined;
  }

  findPeerByOracle(oracle: string): DiscoveredPeer | undefined {
    for (const peer of this.discoveredPeers.values()) {
      if (peer.oracles.some((o) => o.includes(oracle))) return peer;
    }
    return undefined;
  }

  findPeerByZid(zid: string): DiscoveredPeer | undefined {
    return this.discoveredPeers.get(zid);
  }
}
