/**
 * Zenoh Scout discovery provider.
 *
 * This is intentionally discovery-only: it advertises/reads MAW presence via
 * zenoh liveliness and exposes rows through TransportRouter.listDiscoveredPeers().
 * Pairing, TOFU/pubkey trust, and user-facing peer registry writes stay in the
 * existing MAW HTTP pair/peers flow.
 */

import type {
  Transport,
  TransportTarget,
  TransportMessage,
  TransportPresence,
} from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";
import type { DiscoveredPeer } from "./scout-state";
import {
  discoveryKey,
  keyexprFromReply,
  parseDiscoveryKey,
  type ImportZenoh,
  type ZenohApi,
  type ZenohScoutConfig,
  type ZenohSession,
} from "../vendor/mpr-plugins/zenoh-scout/impl";

export interface ZenohScoutTransportConfig extends ZenohScoutConfig {
  pollMs?: number;
  importZenoh?: ImportZenoh;
  now?: () => Date;
}

const DEFAULT_POLL_MS = 5_000;

export class ZenohScoutTransport implements Transport {
  readonly name = "zenoh-scout";
  private _connected = false;
  private readonly config: ZenohScoutTransportConfig;
  private zenoh: ZenohApi | null = null;
  private session: ZenohSession | null = null;
  private token: { undeclare(): Promise<void> } | null = null;
  private readonly peers = new Map<string, DiscoveredPeer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(config: ZenohScoutTransportConfig) {
    this.config = config;
  }

  get connected() {
    return this._connected;
  }

  async connect(): Promise<void> {
    await this.refresh();
    const pollMs = Math.max(250, this.config.pollMs ?? DEFAULT_POLL_MS);
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, pollMs);
  }

  async disconnect(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.closeSession();
    this.peers.clear();
    this._connected = false;
  }

  async send(_target: TransportTarget, _message: string): Promise<boolean> {
    return false;
  }

  async publishPresence(_presence: TransportPresence): Promise<void> {
    await this.refresh();
  }

  async publishFeed(_event: FeedEvent): Promise<void> {}

  onMessage(handler: (msg: TransportMessage) => void) {
    this.msgHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  canReach(_target: TransportTarget): boolean {
    return false;
  }

  listPeers(): DiscoveredPeer[] {
    return [...this.peers.values()];
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshInner().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshInner(): Promise<void> {
    try {
      await this.ensureSession();
      const zenoh = this.zenoh!;
      const session = this.session!;
      const timeout = zenoh.Duration?.milliseconds?.of(this.config.timeoutMs) ?? this.config.timeoutMs;
      const receiver = await session.liveliness().get(new zenoh.KeyExpr(`${this.config.keyPrefix}/**`), { timeout });
      const next = new Map<string, DiscoveredPeer>();
      const now = this.config.now?.() ?? new Date();
      if (receiver) {
        for await (const reply of receiver) {
          const key = keyexprFromReply(reply);
          if (!key) continue;
          const peer = parseDiscoveryKey(key, this.config.keyPrefix, now);
          if (!peer) continue;
          if (peer.node === this.config.node && peer.oracle === this.config.oracle) continue;
          const previous = this.peers.get(peer.zid);
          const lastSeen = Date.parse(peer.lastSeen);
          next.set(peer.zid, {
            zid: peer.zid,
            node: peer.node,
            host: peer.host,
            oracle: peer.oracle,
            locators: peer.locators,
            capabilities: peer.capabilities,
            oracles: peer.oracles,
            lastSeen: Number.isFinite(lastSeen) ? lastSeen : now.getTime(),
            paired: previous?.paired ?? peer.paired,
          });
          this.emitPresence(peer.oracle, peer.host, "ready");
        }
      }
      this.peers.clear();
      for (const [zid, peer] of next) this.peers.set(zid, peer);
      this._connected = true;
    } catch {
      this._connected = false;
      await this.closeSession();
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.session && this.zenoh && (this.config.advertise === false || this.token)) return;
    const importZenoh = this.config.importZenoh ?? (() => import("@eclipse-zenoh/zenoh-ts") as Promise<ZenohApi>);
    const zenoh = await importZenoh();
    const sessionConfig = new zenoh.Config(this.config.locator, this.config.timeoutMs);
    const session = zenoh.Session?.open
      ? await zenoh.Session.open(sessionConfig)
      : await zenoh.open!(sessionConfig);
    const token = this.config.advertise === false
      ? null
      : await session.liveliness().declareToken(new zenoh.KeyExpr(discoveryKey(this.config)));
    this.zenoh = zenoh;
    this.session = session;
    this.token = token;
  }

  private async closeSession(): Promise<void> {
    if (this.token) {
      await this.token.undeclare().catch(() => {});
      this.token = null;
    }
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
    this.zenoh = null;
  }

  private emitPresence(oracle: string, host: string, status: TransportPresence["status"]): void {
    for (const h of this.presenceHandlers) {
      h({ oracle, host, status, timestamp: Date.now() });
    }
  }
}
