import { agentStatusStore, type AgentStatus } from "./agent-status";
import { messageQueue } from "./message-queue";
import { pushFeedEvent } from "../api/feed";
import { buildMessageLifecycleFeedEvent } from "../lib/message-events";

type SendKeysFn = (target: string, text: string) => Promise<void>;

/**
 * Dispatch Engine — auto-delivers queued messages when agents become idle/ready.
 *
 * Listens to AgentStatusStore transitions. When an oracle transitions from
 * busy → ready/idle, delivers the oldest pending message from the queue.
 * One message per transition — avoids flooding an agent that just became free.
 */
export class DispatchEngine {
  private unsub: (() => void) | null = null;
  private delivering = new Set<string>();
  private sendKeys: SendKeysFn;

  constructor(sendKeys: SendKeysFn) {
    this.sendKeys = sendKeys;
  }

  start() {
    if (this.unsub) return;
    this.unsub = agentStatusStore.onChange((_oracle, from, to) => {
      if (from === "busy" && (to === "ready" || to === "idle")) {
        this.tryDeliver(_oracle);
      }
    });
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
  }

  private async tryDeliver(oracle: string) {
    if (this.delivering.has(oracle)) return;
    const msg = messageQueue.next(oracle);
    if (!msg) return;

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
    }
  }

  private emitFeed(msg: typeof messageQueue extends { next(o: string): infer R | undefined } ? NonNullable<R> : never, state: "delivered" | "failed", error?: string) {
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

export function startDispatchEngine(sendKeys: SendKeysFn): DispatchEngine {
  if (dispatchEngine) return dispatchEngine;
  dispatchEngine = new DispatchEngine(sendKeys);
  dispatchEngine.start();
  return dispatchEngine;
}

export function getDispatchEngine(): DispatchEngine | null {
  return dispatchEngine;
}
