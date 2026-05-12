/**
 * LoRa transport — off-grid mesh networking (future hardware).
 *
 * Stub implementation that registers in the transport factory
 * but always returns canReach() → false until hardware arrives.
 * Reserved via `maw radio`.
 */

import type { Transport, TransportTarget, TransportPresence, MessageHandler, PresenceHandler, FeedHandler } from "../core/transport/transport";
import type { FeedEvent } from "../lib/feed";

export class LoRaTransport implements Transport {
  readonly name = "lora";
  private _connected = false;
  private msgHandlers = new Set<MessageHandler>();
  private presenceHandlers = new Set<PresenceHandler>();
  private feedHandlers = new Set<FeedHandler>();

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    // Future: detect Meshtastic USB/serial device
    this._connected = false;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async send(_target: TransportTarget, _message: string): Promise<boolean> {
    return false;
  }

  async publishPresence(_presence: TransportPresence): Promise<void> {}
  async publishFeed(_event: FeedEvent): Promise<void> {}

  onMessage(handler: MessageHandler) { this.msgHandlers.add(handler); }
  onPresence(handler: PresenceHandler) { this.presenceHandlers.add(handler); }
  onFeed(handler: FeedHandler) { this.feedHandlers.add(handler); }

  /** LoRa transport cannot reach anything until hardware is connected */
  canReach(_target: TransportTarget): boolean {
    return false;
  }
}
