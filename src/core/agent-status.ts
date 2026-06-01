import type { FeedEvent } from "../lib/feed";

export type AgentStatus = "busy" | "ready" | "idle" | "crashed" | "offline";

export interface AgentStatusEntry {
  oracle: string;
  status: AgentStatus;
  updatedAt: number;
  sessionId: string;
  project: string;
  /** Last event that caused this status */
  lastEvent: string;
}

const IDLE_TTL = 120_000; // 120s — no activity → idle

/**
 * In-memory agent status store.
 * Primary source: Claude Code hooks (SessionStart/UserPromptSubmit/Stop).
 * Fallback: StatusDetector (tmux screen-hash polling).
 * TTL: agents with no activity for 120s are marked idle.
 */
export class AgentStatusStore {
  private store = new Map<string, AgentStatusEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Update status from a hook event (POST /api/status or feed listener). */
  report(oracle: string, status: AgentStatus, meta?: { sessionId?: string; project?: string; event?: string }) {
    this.clearTimer(oracle);
    const entry: AgentStatusEntry = {
      oracle,
      status,
      updatedAt: Date.now(),
      sessionId: meta?.sessionId ?? this.store.get(oracle)?.sessionId ?? "",
      project: meta?.project ?? this.store.get(oracle)?.project ?? "",
      lastEvent: meta?.event ?? status,
    };
    this.store.set(oracle, entry);

    if (status === "busy" || status === "ready") {
      this.timers.set(oracle, setTimeout(() => {
        const current = this.store.get(oracle);
        if (current && (current.status === "busy" || current.status === "ready")) {
          current.status = "idle";
          current.updatedAt = Date.now();
          current.lastEvent = "ttl-timeout";
        }
      }, IDLE_TTL));
    }
  }

  /** Derive status from a feed event. */
  handleFeedEvent(event: FeedEvent) {
    const status = feedEventToStatus(event.event);
    if (!status) return;
    this.report(event.oracle, status, {
      sessionId: event.sessionId,
      project: event.project,
      event: event.event,
    });
  }

  get(oracle: string): AgentStatusEntry | undefined {
    return this.store.get(oracle);
  }

  getAll(): AgentStatusEntry[] {
    return [...this.store.values()];
  }

  remove(oracle: string) {
    this.clearTimer(oracle);
    this.store.delete(oracle);
  }

  private clearTimer(oracle: string) {
    const t = this.timers.get(oracle);
    if (t) { clearTimeout(t); this.timers.delete(oracle); }
  }
}

function feedEventToStatus(event: string): AgentStatus | null {
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "SubagentStart":
      return "busy";
    case "Stop":
    case "PostToolUse":
    case "SubagentStop":
    case "TaskCompleted":
      return "ready";
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

/** Singleton — shared between API and engine. */
export const agentStatusStore = new AgentStatusStore();
