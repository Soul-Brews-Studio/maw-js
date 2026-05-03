/**
 * Transport abstraction layer for maw-js.
 *
 * The fleet currently communicates via tmux (local) and HTTP federation (peers).
 * This module introduces a pluggable transport interface so messaging can flow
 * through MQTT (oracle-mesh-signal), HTTP, or tmux depending on target location.
 *
 * Local targets → tmux (fast path, 50ms capture loop)
 * Remote targets → MQTT publish to oracle/{name}/inbox
 * Fallback → HTTP federation (existing peers[] mechanism)
 */

import type { FeedEvent } from "../../lib/feed";

/** Transport failure reasons (inspired by OpenClaw's FailoverReason) */
export type TransportFailureReason =
  | "timeout"        // Network timeout
  | "unreachable"    // Host/peer down
  | "auth"           // Authentication failed
  | "rate_limit"     // Too many requests
  | "rejected"       // Peer rejected message
  | "parse_error"    // Malformed response
  | "unknown";       // Unclassified

/** Result of a transport send attempt */
export interface TransportResult {
  ok: boolean;
  via: string;
  reason?: TransportFailureReason;
  retryable: boolean;
}

/** Classify common error patterns into failure reasons */
export function classifyError(err: unknown): { reason: TransportFailureReason; retryable: boolean } {
  if (!err) return { reason: "unknown", retryable: false };
  const msg = String(err).toLowerCase();
  if (/timeout|etimedout|econnreset/.test(msg)) return { reason: "timeout", retryable: true };
  if (/econnrefused|unreachable|enetunreach/.test(msg)) return { reason: "unreachable", retryable: true };
  if (/401|403|auth|unauthorized|forbidden/.test(msg)) return { reason: "auth", retryable: false };
  if (/429|rate.?limit|too many/.test(msg)) return { reason: "rate_limit", retryable: true };
  if (/400|reject|denied/.test(msg)) return { reason: "rejected", retryable: false };
  if (/parse|json|syntax/.test(msg)) return { reason: "parse_error", retryable: false };
  return { reason: "unknown", retryable: false };
}

/** Where a message should be delivered */
export interface TransportTarget {
  oracle: string;        // e.g. "neo", "pulse"
  host?: string;         // e.g. "white.local", "remote-host" — null = local
  tmuxTarget?: string;   // e.g. "main:3" — only for local tmux
}

/** A message flowing through the transport */
export interface TransportMessage {
  from: string;          // sender oracle name
  to: string;            // recipient oracle name
  body: string;          // the actual message text
  timestamp: number;     // epoch ms
  transport: "tmux" | "mqtt" | "http" | "hub" | "scout";  // which channel carried it
}

/** Presence info broadcast by each host */
export interface TransportPresence {
  oracle: string;
  host: string;
  status: "busy" | "ready" | "idle" | "crashed" | "offline";
  timestamp: number;
}

/** Abstract transport — implementations handle different channels */
export interface Transport {
  readonly name: string;

  /** Connect / initialize */
  connect(): Promise<void>;

  /** Disconnect / cleanup */
  disconnect(): Promise<void>;

  /** Send a message to a target */
  send(target: TransportTarget, message: string): Promise<boolean>;

  /** Publish presence/heartbeat */
  publishPresence(presence: TransportPresence): Promise<void>;

  /** Publish a feed event to remote listeners */
  publishFeed(event: FeedEvent): Promise<void>;

  /** Register handler for incoming messages */
  onMessage(handler: (msg: TransportMessage) => void): void;

  /** Register handler for presence updates */
  onPresence(handler: (presence: TransportPresence) => void): void;

  /** Register handler for remote feed events */
  onFeed(handler: (event: FeedEvent) => void): void;

  /** Check if this transport can reach a given target */
  canReach(target: TransportTarget): boolean;

  /** Whether the transport is currently connected */
  readonly connected: boolean;
}

/**
 * TransportRouter — routes messages through the best available transport.
 *
 * Priority:
 * 1. tmux (local, fastest)
 * 2. MQTT (real-time, cross-host)
 * 3. HTTP federation (fallback, polling-based)
 */
export class TransportRouter {
  private transports: Transport[] = [];
  private messageHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  /** Register a transport (order matters — first match wins for send) */
  register(transport: Transport) {
    this.transports.push(transport);

    // Wire up incoming events from all transports
    transport.onMessage((msg) => {
      for (const h of this.messageHandlers) h(msg);
    });
    transport.onPresence((p) => {
      for (const h of this.presenceHandlers) h(p);
    });
    transport.onFeed((e) => {
      for (const h of this.feedHandlers) h(e);
    });
  }

  /** Connect all registered transports */
  async connectAll(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.connect()));
  }

  /** Disconnect all */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.disconnect()));
  }

  /** Send a message — routes through the first transport that can reach the target, with failover */
  async send(target: TransportTarget, message: string, from: string): Promise<TransportResult> {
    for (const t of this.transports) {
      if (t.connected && t.canReach(target)) {
        try {
          const ok = await t.send(target, message);
          if (ok) return { ok: true, via: t.name, retryable: false };
          // Send returned false — try next transport
          console.log(`[transport] ${t.name}: send failed for ${target.oracle}, trying next`);
        } catch (err) {
          const { reason, retryable } = classifyError(err);
          console.log(`[transport] ${t.name}: ${reason}${retryable ? " (retryable)" : ""} — trying next`);
          if (!retryable) return { ok: false, via: t.name, reason, retryable };
          // retryable → continue to next transport
        }
      }
    }
    return { ok: false, via: "none", reason: "unreachable", retryable: false };
  }

  /** Broadcast presence through all connected transports */
  async publishPresence(presence: TransportPresence): Promise<void> {
    await Promise.allSettled(
      this.transports
        .filter((t) => t.connected)
        .map((t) => t.publishPresence(presence)),
    );
  }

  /** Broadcast a feed event through all connected transports */
  async publishFeed(event: FeedEvent): Promise<void> {
    await Promise.allSettled(
      this.transports
        .filter((t) => t.connected)
        .map((t) => t.publishFeed(event)),
    );
  }

  onMessage(handler: (msg: TransportMessage) => void) {
    this.messageHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  /** Get status of all transports */
  status(): { name: string; connected: boolean }[] {
    return this.transports.map((t) => ({ name: t.name, connected: t.connected }));
  }
}
