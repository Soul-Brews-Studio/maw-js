/**
 * NanoClaw transport — bridge to external chat channels (Telegram, Discord, etc.)
 *
 * Routes messages through a running NanoClaw instance via HTTP.
 * Config: maw.config.json → nanoclaw: { url: "http://localhost:3001", channels: { nat: "tg:123456789" } }
 *
 * canReach() returns true for targets matching nanoclaw channel aliases or JID patterns.
 * send() POSTs { jid, text } to nanoclaw's /send endpoint for delivery.
 */

import type { Transport, TransportTarget, TransportPresence, MessageHandler, PresenceHandler, FeedHandler } from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";
import { resolveNanoclawJid, sendViaNanoclaw } from "../bridges/nanoclaw";

export class NanoclawTransport implements Transport {
  readonly name = "nanoclaw";
  private _connected = true; // Stateless HTTP — always "connected"
  private msgHandlers = new Set<MessageHandler>();
  private presenceHandlers = new Set<PresenceHandler>();
  private feedHandlers = new Set<FeedHandler>();

  get connected() { return this._connected; }

  async connect(): Promise<void> { this._connected = true; }
  async disconnect(): Promise<void> { this._connected = false; }

  async send(target: TransportTarget, message: string): Promise<boolean> {
    const resolved = resolveNanoclawJid(target.oracle);
    if (!resolved) return false;
    return sendViaNanoclaw(resolved.jid, message, resolved.url);
  }

  async publishPresence(_presence: TransportPresence): Promise<void> {}
  async publishFeed(_event: FeedEvent): Promise<void> {}

  onMessage(handler: MessageHandler) { this.msgHandlers.add(handler); }
  onPresence(handler: PresenceHandler) { this.presenceHandlers.add(handler); }
  onFeed(handler: FeedHandler) { this.feedHandlers.add(handler); }

  /** Can reach targets that resolve to a nanoclaw channel JID */
  canReach(target: TransportTarget): boolean {
    return resolveNanoclawJid(target.oracle) !== null;
  }
}
