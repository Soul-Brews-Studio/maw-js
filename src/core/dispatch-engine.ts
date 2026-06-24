import { agentStatusStore, type AgentStatus } from "./agent-status";
import { messageQueue, type QueuedMessage } from "./message-queue";
import { pushFeedEvent } from "../api/feed";
import { buildMessageLifecycleFeedEvent } from "../lib/message-events";
import { D } from "../config/types";

type SendKeysFn = (target: string, text: string) => Promise<void>;
/** Returns true when the pane is safe to inject into (no operator input mid-edit). */
type PaneIdleFn = (target: string) => Promise<boolean>;
/** Surface a pending-message badge on the target (eq3-003); count 0 clears it. */
type SetIndicatorFn = (target: string, count: number) => Promise<void>;

export interface DispatchEngineOptions {
  /** Pane-input guard — when omitted, panes are assumed always idle (legacy behavior). */
  paneIdle?: PaneIdleFn;
  /** tmux pending-count badge setter — when omitted, the indicator is a no-op. */
  setIndicator?: SetIndicatorFn;
  /** A deferred message older than this (ms) fires a one-shot stall notify. 0 disables. */
  stallThresholdMs?: number;
}

export interface FlushResult {
  delivered: number;
  deferred: number;
  remaining: number;
}

/**
 * Dispatch Engine — auto-delivers queued messages when agents become idle/ready,
 * and never overtypes operator input that is mid-edit on the target pane (eq3-003).
 *
 * Four delivery paths, all sharing the same zero-overtype `paneIdle` re-check:
 *   1. busy→ready transition  → tryDeliver (one message, throttled)
 *   2. `maw flush` / hook      → flush(oracle) (drain all deliverable)
 *   3. periodic sweep          → runSweepOnce (hook-independent net)
 *   4. stall notify            → one-shot Notification when stuck past threshold
 *
 * A message is only ever delivered when the pane is clean. If the operator is
 * typing, it stays queued — surfaced via the tmux `@maw_pending` badge and,
 * past the stall threshold, a single Notification feed event. It is NEVER
 * force-delivered: overtyping is the exact failure mode this engine prevents.
 */
export class DispatchEngine {
  private unsub: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private delivering = new Set<string>();
  /** Last target seen per oracle — lets us clear the badge after the queue drains to empty. */
  private lastTarget = new Map<string, string>();
  private sendKeys: SendKeysFn;
  private paneIdle: PaneIdleFn;
  private setIndicator: SetIndicatorFn;
  private stallThresholdMs: number;

  constructor(sendKeys: SendKeysFn, opts: DispatchEngineOptions = {}) {
    this.sendKeys = sendKeys;
    this.paneIdle = opts.paneIdle ?? (async () => true);
    this.setIndicator = opts.setIndicator ?? (async () => {});
    this.stallThresholdMs = opts.stallThresholdMs ?? D.inputGuard.stallNotifyMs;
  }

  start() {
    if (this.unsub) return;
    this.unsub = agentStatusStore.onChange((_oracle, from, to) => {
      if (from === "busy" && (to === "ready" || to === "idle")) {
        this.tryDeliver(_oracle);
      }
    });
  }

  /** Start the periodic deferred-queue sweep (the hook-independent net). 0 disables. */
  startSweep(intervalMs: number) {
    if (this.sweepTimer || intervalMs <= 0) return;
    this.sweepTimer = setInterval(() => { void this.runSweepOnce(); }, intervalMs);
    // Don't keep the process alive solely for the sweep.
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }

  /**
   * Sweep tick: for every oracle with a deferred message, deliver whatever the
   * now-clean pane allows, then fire a one-shot stall notify for anything still
   * stuck. Hook-independent — guarantees eventual delivery even when the
   * operator clears their input without ever submitting (no Stop/UserPromptSubmit
   * hook fires).
   */
  async runSweepOnce(): Promise<void> {
    for (const oracle of messageQueue.pendingOracles()) {
      try {
        await this.flush(oracle);
        await this.checkStall(oracle);
      } catch { /* one oracle's failure must not stall the rest */ }
    }
  }

  /**
   * Drain every deliverable message for `oracle`, re-checking pane-clean before
   * EACH inject (race-safe — the operator may start typing mid-drain). Dirty
   * messages stay queued. Idempotent: calling repeatedly on a clean pane is a
   * no-op once drained, and on a dirty pane never delivers.
   */
  async flush(oracle: string): Promise<FlushResult> {
    if (this.delivering.has(oracle)) {
      const remaining = messageQueue.pending(oracle).length;
      return { delivered: 0, deferred: remaining, remaining };
    }
    this.delivering.add(oracle);
    let delivered = 0;
    let deferred = 0;
    try {
      const pending = messageQueue.pending(oracle);
      if (pending[0]) this.lastTarget.set(oracle, pending[0].target);
      for (const msg of pending) {
        if (!(await this.paneIdle(msg.target))) { deferred++; continue; }
        messageQueue.markDelivering(msg.id);
        try {
          await this.sendKeys(msg.target, msg.message);
          messageQueue.markDelivered(msg.id);
          delivered++;
          this.emitFeed(msg, "delivered");
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          messageQueue.markFailed(msg.id, error);
          this.emitFeed(msg, "failed", error);
        }
      }
    } finally {
      this.delivering.delete(oracle);
    }
    await this.refreshIndicator(oracle);
    return { delivered, deferred, remaining: messageQueue.pending(oracle).length };
  }

  private async tryDeliver(oracle: string) {
    if (this.delivering.has(oracle)) return;
    const msg = messageQueue.next(oracle);
    if (!msg) return;
    this.lastTarget.set(oracle, msg.target);
    // eq3-003 — never overtype: if the operator is mid-typing, leave the message
    // queued; the sweep / next transition / `maw flush` will retry.
    if (!(await this.paneIdle(msg.target))) {
      await this.refreshIndicator(oracle);
      return;
    }

    this.delivering.add(oracle);
    messageQueue.markDelivering(msg.id);

    try {
      await this.sendKeys(msg.target, msg.message);
      messageQueue.markDelivered(msg.id);
      this.emitFeed(msg, "delivered");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      messageQueue.markFailed(msg.id, error);
      this.emitFeed(msg, "failed", error);
    } finally {
      this.delivering.delete(oracle);
      await this.refreshIndicator(oracle);
    }
  }

  /**
   * Reflect the current deferred-message count on the oracle's tmux window via
   * the `@maw_pending` badge. Clears (unsets) once the queue drains to empty,
   * restoring the operator's pristine status bar.
   */
  async refreshIndicator(oracle: string): Promise<void> {
    const pending = messageQueue.pending(oracle);
    const target = pending[0]?.target ?? this.lastTarget.get(oracle);
    if (!target) return;
    try { await this.setIndicator(target, pending.length); } catch { /* best-effort */ }
    if (pending.length === 0) this.lastTarget.delete(oracle);
  }

  /**
   * One-shot stall notify: when a message has sat behind dirty input longer
   * than the threshold, emit a single Notification feed event (deduped via
   * `stallNotified`). Never escalates to force-delivery.
   */
  private async checkStall(oracle: string): Promise<void> {
    if (this.stallThresholdMs <= 0) return;
    const now = Date.now();
    const stale = messageQueue
      .pending(oracle)
      .filter(m => !m.stallNotified && now - m.queuedAt >= this.stallThresholdMs);
    if (stale.length === 0) return;
    for (const m of stale) messageQueue.markStallNotified(m.id);
    const target = stale[0].target;
    const count = messageQueue.pending(oracle).length;
    try {
      pushFeedEvent({
        timestamp: new Date(now).toISOString(),
        oracle,
        host: "local",
        event: "Notification",
        project: "",
        sessionId: target,
        message: `📬 ${count} message(s) waiting on ${oracle} — operator input pending; not overtyping`,
        ts: now,
        data: { kind: "dispatch-stall", oracle, target, count },
      });
    } catch { /* notify is best-effort; never block */ }
  }

  private emitFeed(msg: QueuedMessage, state: "delivered" | "failed", error?: string) {
    try {
      pushFeedEvent(buildMessageLifecycleFeedEvent({
        direction: "outbound",
        state,
        channel: "dispatch",
        route: "local",
        from: msg.from,
        to: msg.to,
        target: msg.target,
        text: msg.message,
        lastLine: state === "delivered" ? "auto-dispatched from queue" : "",
        error,
        signed: false,
      }));
    } catch {}
  }
}

let dispatchEngine: DispatchEngine | null = null;

export function startDispatchEngine(sendKeys: SendKeysFn, opts: DispatchEngineOptions & { sweepIntervalMs?: number } = {}): DispatchEngine {
  if (dispatchEngine) return dispatchEngine;
  dispatchEngine = new DispatchEngine(sendKeys, opts);
  dispatchEngine.start();
  if (opts.sweepIntervalMs) dispatchEngine.startSweep(opts.sweepIntervalMs);
  return dispatchEngine;
}

export function getDispatchEngine(): DispatchEngine | null {
  return dispatchEngine;
}
