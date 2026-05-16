/**
 * Zenoh transport — pub/sub + query/reply via zenoh-ts.
 *
 * Connects to a zenohd router via WebSocket (zenoh-plugin-remote-api).
 * Provides real-time messaging, presence via liveliness tokens, and
 * auto-discovery — replacing HTTP polling for cross-node communication.
 *
 * Config: maw.config.json → zenoh.locator = "ws://host:10000"
 * Requires: zenohd running with --cfg "plugins/remote_api/**":true
 */

import type {
  Transport,
  TransportTarget,
  TransportMessage,
  TransportPresence,
} from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";

export interface ZenohTransportConfig {
  locator: string;
  node: string;
}

export interface ZenohRuntime {
  open(config: unknown): Promise<unknown>;
  Config: new (locator: string) => unknown;
}

export interface ZenohTransportDeps {
  importZenoh?: () => Promise<ZenohRuntime>;
  now?: () => number;
  logger?: Pick<Console, "log" | "warn">;
}

export class ZenohTransport implements Transport {
  readonly name = "zenoh";
  private _connected = false;
  private session: any = null;
  private config: ZenohTransportConfig;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();
  private subscribers: any[] = [];
  private livelinessToken: any = null;
  private deps: ZenohTransportDeps;

  constructor(config: ZenohTransportConfig, deps: ZenohTransportDeps = {}) {
    this.config = config;
    this.deps = deps;
  }

  get connected() {
    return this._connected;
  }

  async connect(): Promise<void> {
    try {
      const { open, Config } = await this.importZenoh();
      const config = new Config(this.config.locator);
      this.session = await open(config) as any;
      this._connected = true;

      // Declare liveliness token for presence
      const liveliness = this.session.liveliness();
      this.livelinessToken = await liveliness.declareToken(
        `maw/${this.config.node}/alive`,
      );

      // Subscribe to messages for this node
      const msgSub = await this.session.declareSubscriber(
        `maw/*/hey/${this.config.node}`,
        {
          handler: (sample: any) => {
            try {
              const msg: TransportMessage = JSON.parse(
                new TextDecoder().decode(sample.payload().toBytes()),
              );
              msg.transport = "zenoh" as any;
              for (const h of this.msgHandlers) h(msg);
            } catch {}
          },
        },
      );
      this.subscribers.push(msgSub);

      // Subscribe to presence updates
      const presenceSub = await this.session.declareSubscriber(
        "maw/*/presence",
        {
          handler: (sample: any) => {
            try {
              const presence: TransportPresence = JSON.parse(
                new TextDecoder().decode(sample.payload().toBytes()),
              );
              for (const h of this.presenceHandlers) h(presence);
            } catch {}
          },
        },
      );
      this.subscribers.push(presenceSub);

      // Subscribe to feed events
      const feedSub = await this.session.declareSubscriber("maw/*/feed", {
        handler: (sample: any) => {
          try {
            const event: FeedEvent = JSON.parse(
              new TextDecoder().decode(sample.payload().toBytes()),
            );
            for (const h of this.feedHandlers) h(event);
          } catch {}
        },
      });
      this.subscribers.push(feedSub);

      (this.deps.logger ?? console).log(
        `[zenoh] connected to ${this.config.locator} as ${this.config.node}`,
      );
    } catch (err) {
      (this.deps.logger ?? console).warn(
        `[zenoh] connect failed: ${err instanceof Error ? err.message : err}`,
      );
      this._connected = false;
    }
  }

  async disconnect(): Promise<void> {
    try {
      for (const sub of this.subscribers) {
        try {
          await sub.undeclare();
        } catch {}
      }
      this.subscribers = [];
      if (this.livelinessToken) {
        try {
          await this.livelinessToken.undeclare();
        } catch {}
        this.livelinessToken = null;
      }
      if (this.session) {
        await this.session.close();
        this.session = null;
      }
    } catch {}
    this._connected = false;
  }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    if (!this.session || !this._connected) return false;
    try {
      const topic = `maw/${this.config.node}/hey/${target.oracle}`;
      const msg: TransportMessage = {
        from: this.config.node,
        to: target.oracle,
        body: message,
        timestamp: (this.deps.now ?? Date.now)(),
        transport: "zenoh" as any,
      };
      await this.session.put(topic, new TextEncoder().encode(JSON.stringify(msg)));
      return true;
    } catch {
      return false;
    }
  }

  async publishPresence(presence: TransportPresence): Promise<void> {
    if (!this.session || !this._connected) return;
    try {
      const topic = `maw/${this.config.node}/presence`;
      await this.session.put(topic, new TextEncoder().encode(JSON.stringify(presence)));
    } catch {}
  }

  async publishFeed(event: FeedEvent): Promise<void> {
    if (!this.session || !this._connected) return;
    try {
      const topic = `maw/${this.config.node}/feed`;
      await this.session.put(topic, new TextEncoder().encode(JSON.stringify(event)));
    } catch {}
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
    return this._connected;
  }

  private async importZenoh(): Promise<ZenohRuntime> {
    if (this.deps.importZenoh) return this.deps.importZenoh();
    return import("@eclipse-zenoh/zenoh-ts") as Promise<ZenohRuntime>;
  }
}
