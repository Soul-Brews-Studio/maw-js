/**
 * Tmux transport — local fast path.
 *
 * Wraps the existing tmux send-keys mechanism as a Transport interface.
 * This is always the first transport tried for local targets.
 */

import { sendKeys, listSessions } from "../ssh";
import { findWindow } from "../find-window";
import type { Transport, TransportTarget, TransportMessage, TransportPresence } from "../transport";
import type { FeedEvent } from "../lib/feed";

export class TmuxTransport implements Transport {
  readonly name = "tmux";
  private _connected = false;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  get connected() { return this._connected; }

  async connect(): Promise<void> {
    // tmux is always "connected" if we're on the host
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  /** Send message via tmux send-keys — only works for local targets */
  async send(target: TransportTarget, message: string): Promise<boolean> {
    if (target.host && target.host !== "local" && target.host !== "localhost") {
      return false; // Not a local target
    }

    try {
      // Resolve tmux target if not provided
      let tmuxTarget = target.tmuxTarget;
      if (!tmuxTarget) {
        const sessions = await listSessions();
        tmuxTarget = findWindow(sessions, target.oracle);
        if (!tmuxTarget) return false;
      }

      await sendKeys(tmuxTarget, message);
      return true;
    } catch {
      return false;
    }
  }

  /** Presence is handled by the StatusDetector — no-op here */
  async publishPresence(_presence: TransportPresence): Promise<void> {}

  /** Feed events are handled by the MawEngine — no-op here */
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

  /** tmux transport can reach any local target */
  canReach(target: TransportTarget): boolean {
    return !target.host || target.host === "local" || target.host === "localhost";
  }
}
