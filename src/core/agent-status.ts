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
const ACTIVE_STATUS_MAX_AGE = 48 * 60 * 60_000; // 48h — even busy/ready entries eventually expire

/**
 * In-memory agent status store.
 * Primary source: Claude Code hooks (SessionStart/UserPromptSubmit/Stop).
 * Fallback: StatusDetector (tmux screen-hash polling).
 * TTL: agents with no activity for 120s are marked idle.
 */
export type StatusChangeListener = (oracle: string, from: AgentStatus | null, to: AgentStatus) => void;

export class AgentStatusStore {
  private store = new Map<string, AgentStatusEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<StatusChangeListener>();

  /** Register a callback fired on every status transition. */
  onChange(listener: StatusChangeListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(oracle: string, from: AgentStatus | null, to: AgentStatus) {
    for (const fn of this.listeners) {
      try { fn(oracle, from, to); } catch {}
    }
  }

  /** Update status from a hook event (POST /api/status or feed listener). */
  report(oracle: string, status: AgentStatus, meta?: { sessionId?: string; project?: string; event?: string }) {
    this.clearTimer(oracle);
    const prev = this.store.get(oracle);
    const prevStatus = prev?.status ?? null;
    const entry: AgentStatusEntry = {
      oracle,
      status,
      updatedAt: Date.now(),
      sessionId: meta?.sessionId ?? prev?.sessionId ?? "",
      project: meta?.project ?? prev?.project ?? "",
      lastEvent: meta?.event ?? status,
    };
    this.store.set(oracle, entry);

    if (prevStatus !== status) this.emit(oracle, prevStatus, status);

    if (status === "busy" || status === "ready") {
      this.timers.set(oracle, setTimeout(() => {
        const current = this.store.get(oracle);
        if (current && (current.status === "busy" || current.status === "ready")) {
          const was = current.status;
          current.status = "idle";
          current.updatedAt = Date.now();
          current.lastEvent = "ttl-timeout";
          this.emit(oracle, was, "idle");
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

  /** Prune stale statuses so long-lived maw serve processes do not retain old oracle names forever. */
  prune(maxAge = 24 * 60 * 60_000): number {
    const now = Date.now();
    const cutoff = now - maxAge;
    const activeCutoff = now - ACTIVE_STATUS_MAX_AGE;
    let removed = 0;
    for (const [oracle, entry] of this.store) {
      const isActiveStatus = entry.status === "busy" || entry.status === "ready";
      const expiresAt = isActiveStatus ? activeCutoff : cutoff;
      if (entry.updatedAt >= expiresAt) continue;
      this.remove(oracle);
      removed++;
    }
    return removed;
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
