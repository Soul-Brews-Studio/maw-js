import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session, AgentState, PaneStatus, AgentEvent } from "../lib/types";
import type { Team } from "../components/TeamPanel";
import { stripAnsi } from "../lib/ansi";
import { agentSortKey } from "../lib/constants";
import { playWakeSound } from "../lib/sounds";
import { useFleetStore } from "../lib/store";
import { activeOracles, describeActivity, type FeedEvent, type FeedEventType } from "../lib/feed";
import type { AskType } from "../lib/types";

const BUSY_TIMEOUT = 15_000; // 15s without feed → ready
const IDLE_TIMEOUT = 60_000; // 60s without feed → idle

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [captureData, setCaptureData] = useState<Record<string, { preview: string; status: PaneStatus }>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [eventLog, setEventLog] = useState<AgentEvent[]>([]);
  const MAX_EVENTS = 200;

  // Agent Teams state
  const [teams, setTeams] = useState<Team[]>([]);

  // Oracle feed state
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const feedEventsRef = useRef<FeedEvent[]>([]);
  feedEventsRef.current = feedEvents;
  const MAX_FEED = 100;

  const addEvent = useCallback((target: string, type: AgentEvent["type"], detail: string) => {
    setEventLog(prev => {
      const next = [...prev, { time: Date.now(), target, type, detail }];
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    });
  }, []);

  const markBusy = useFleetStore((s) => s.markBusy);
  const markSlept = useFleetStore((s) => s.markSlept);
  const clearSlept = useFleetStore((s) => s.clearSlept);

  const agentsRef = useRef<AgentState[]>([]);
  const lastSoundTime = useRef(0);

  // --- Feed-based status tracking ---
  // target → last feed timestamp, target → last event type
  const feedLastSeen = useRef<Record<string, number>>({});
  const feedLastEvent = useRef<Record<string, FeedEventType>>({});

  const FEED_BUSY_EVENTS = new Set<FeedEventType>(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SubagentStart", "PostToolUseFailure"]);
  const FEED_STOP_EVENTS = new Set<FeedEventType>(["Stop", "SessionEnd", "TaskCompleted", "Notification"]);

  /** Resolve feed event → agent. Uses project field for worktree-aware matching (case-insensitive). */
  const resolveAgentFromFeed = useCallback((event: FeedEvent): AgentState | undefined => {
    // project like "hermes-oracle.wt-1-bitkub" or "homelab-wt-statusline" → window name "hermes-bitkub" / "homekeeper-statusline"
    const project = event.project;
    // Match both formats: ".wt-N-name" (old) and "-wt-name" (new, no digit)
    const wtMatch = project.match(/[.-]wt-(?:\d+-)?(.+)$/);
    if (wtMatch) {
      const windowName = `${event.oracle}-${wtMatch[1]}`.toLowerCase();
      const agent = agentsRef.current.find(a => a.name.toLowerCase() === windowName);
      if (agent) return agent;
    }
    // Fallback: match by oracle name (main window)
    // Handle both formats: oracle="neo" → "neo-oracle", oracle="calliope-oracle" → "calliope-oracle"
    const oracleLower = event.oracle.toLowerCase();
    const oracleMain = oracleLower.endsWith("-oracle") ? oracleLower : `${oracleLower}-oracle`;
    return agentsRef.current.find(a => a.name.toLowerCase() === oracleMain)
      || agentsRef.current.find(a => a.name.toLowerCase() === oracleLower);
  }, []);

  const updateStatusFromFeed = useCallback((event: FeedEvent) => {
    const agent = resolveAgentFromFeed(event);
    if (!agent) return;

    const target = agent.target;

    feedLastEvent.current[target] = event.event;

    if (FEED_BUSY_EVENTS.has(event.event)) {
      feedLastSeen.current[target] = Date.now();
      setCaptureData(prev => {
        const existing = prev[target];
        if (existing?.status === "busy") return prev;
        // Play per-oracle wake sound on transition to busy (10s cooldown)
        const now = Date.now();
        if (now - lastSoundTime.current > 10_000) {
          lastSoundTime.current = now;
          playWakeSound(agent.name);
        }
        if (existing && existing.status !== "busy") addEvent(target, "status", `${existing.status} → busy`);
        clearSlept(target);
        return { ...prev, [target]: { preview: existing?.preview || "", status: "busy" } };
      });
    } else if (FEED_STOP_EVENTS.has(event.event)) {
      feedLastSeen.current[target] = 0; // mark stopped
      setCaptureData(prev => {
        const existing = prev[target];
        if (existing?.status === "ready") return prev;
        if (existing && existing.status !== "ready") addEvent(target, "status", `${existing.status} → ready`);
        return { ...prev, [target]: { preview: existing?.preview || "", status: "ready" } };
      });
    }
  }, [addEvent, clearSlept, resolveAgentFromFeed]);

  // Decay: busy → ready after 15s, ready → idle after 60s without feed events
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCaptureData(prev => {
        let next = prev;
        for (const agent of agentsRef.current) {
          const lastSeen = feedLastSeen.current[agent.target] || 0;
          const existing = prev[agent.target];
          if (!existing) continue;

          // Don't decay busy→ready if agent is in a tool call (PreToolUse without PostToolUse)
          const lastEvt = feedLastEvent.current[agent.target];
          const inToolCall = lastEvt === "PreToolUse" || lastEvt === "SubagentStart";
          if (existing.status === "busy" && lastSeen > 0 && now - lastSeen > BUSY_TIMEOUT && !inToolCall) {
            if (next === prev) next = { ...prev };
            next[agent.target] = { ...existing, status: "ready" };
          } else if (existing.status === "ready" && (lastSeen === 0 || now - lastSeen > IDLE_TIMEOUT)) {
            if (next === prev) next = { ...prev };
            next[agent.target] = { ...existing, status: "idle" };
          }
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // --- Ask detection from feed events ---
  const ASK_RESUME_EVENTS = new Set<FeedEventType>(["PreToolUse", "SubagentStart", "UserPromptSubmit"]);
  // Store last Stop message per oracle — Stop fires before Notification, carries the real question
  const lastStopMessage = useRef<Record<string, string>>({});

  const detectAsk = useCallback((event: FeedEvent) => {
    const { addAsk, dismissByOracle } = useFleetStore.getState();
    const agent = resolveAgentFromFeed(event);

    // Auto-dismiss: agent resumed on its own
    if (ASK_RESUME_EVENTS.has(event.event)) {
      const name = agent?.name || event.oracle;
      dismissByOracle(name);
      delete lastStopMessage.current[name];
      return;
    }

    const oracleName = agent?.name || event.oracle;

    // Capture Stop message — this has the actual question text
    if (event.event === "Stop" && event.message.trim()) {
      lastStopMessage.current[oracleName] = event.message.trim();
    }

    if (event.event === "Notification") {
      const msg = event.message.toLowerCase();
      let askType: AskType | null = null;
      if (msg.includes("waiting for your input") || msg.includes("waiting for input")) askType = "input";
      else if (msg.includes("needs your attention") || msg.includes("attention")) askType = "attention";
      else if (msg.includes("needs your approval") || msg.includes("approval")) askType = "plan";
      if (askType) {
        // Find the real question: check ref first, then search feed history for last Stop from this oracle
        let stopMsg = lastStopMessage.current[oracleName];
        if (!stopMsg) {
          for (let i = feedEventsRef.current.length - 1; i >= 0; i--) {
            const fe = feedEventsRef.current[i];
            if (fe.oracle === event.oracle && fe.event === "Stop" && fe.message.trim()) {
              stopMsg = fe.message.trim();
              break;
            }
          }
        }
        const displayMessage = stopMsg && stopMsg.length > event.message.length ? stopMsg : event.message;
        addAsk({ oracle: oracleName, target: agent?.target || "", type: askType, message: displayMessage });
        delete lastStopMessage.current[oracleName];
      }
    }
  }, [resolveAgentFromFeed]);

  const handleMessage = useCallback((data: any) => {
    if (data.type === "sessions") {
      // Filter out PTY helper sessions (maw-pty-*) — they're internal
      setSessions((data.sessions as Session[]).filter(s => !s.name.startsWith("maw-pty-")));
    } else if (data.type === "recent") {
      const agents: { target: string; name: string; session: string }[] = data.agents || [];
      if (agents.length > 0) markBusy(agents);
    } else if (data.type === "feed") {
      const feedEvent = data.event as FeedEvent;
      setFeedEvents(prev => {
        const next = [...prev, feedEvent];
        return next.length > MAX_FEED ? next.slice(-MAX_FEED) : next;
      });
      updateStatusFromFeed(feedEvent);
      detectAsk(feedEvent);
    } else if (data.type === "feed-history") {
      const events = (data.events as FeedEvent[]).slice(-MAX_FEED);
      setFeedEvents(events);
      // Set initial status + populate recentMap from feed events
      for (const e of events) {
        updateStatusFromFeed(e);
        if (FEED_BUSY_EVENTS.has(e.event as FeedEventType)) {
          const agent = resolveAgentFromFeed(e);
          if (agent) markBusy([{ target: agent.target, name: agent.name, session: agent.session }], e.ts);
        }
      }
    } else if (data.type === "teams") {
      setTeams(data.teams || []);
    } else if (data.type === "previews") {
      const previews: Record<string, string> = data.data;
      setCaptureData((prev) => {
        let next = prev;
        for (const [target, raw] of Object.entries(previews)) {
          const text = stripAnsi(raw);
          const lines = text.split("\n").filter((l: string) => l.trim());
          // Prefer a line showing "Compacting" (from /compact) over the default last line (prompt)
          const compactingLine = lines.find((l: string) => l.toLowerCase().includes("compacting"));
          const preview = (compactingLine || lines[lines.length - 1] || "").slice(0, 120);
          const existing = next[target];
          if (!existing || existing.preview !== preview) {
            if (next === prev) next = { ...prev };
            next[target] = { preview, status: existing?.status || "idle" };
          }
        }
        return next;
      });
    } else if (data.type === "action-ok") {
      if (data.action === "sleep") markSlept(data.target);
      else if (data.action === "wake") clearSlept(data.target);
    }
  }, []);

  // Derive flat agent list
  const agents: AgentState[] = useMemo(() => {
    const list = sessions.flatMap((s) =>
      s.windows.map((w) => {
        const key = `${s.name}:${w.index}`;
        const cd = captureData[key];
        // Derive project from cwd (basename, detect worktree)
        let project: string | undefined;
        if (w.cwd) {
          const base = w.cwd.split("/").pop() || "";
          const wtMatch = base.match(/[.-]wt-(?:\d+-)?(.+)$/);
          project = wtMatch ? `wt:${wtMatch[1]}` : base;
        }
        return {
          target: key,
          name: w.name,
          session: s.name,
          windowIndex: w.index,
          active: w.active,
          preview: cd?.preview || "",
          status: cd?.status || "idle",
          project,
          cwd: w.cwd,
        };
      })
    );
    list.sort((a, b) => agentSortKey(a.name) - agentSortKey(b.name));
    agentsRef.current = list;
    return list;
  }, [sessions, captureData]);

  const feedActive = useMemo(() => activeOracles(feedEvents, 5 * 60_000), [feedEvents]);

  const agentFeedLog = useMemo((): Map<string, FeedEvent[]> => {
    const map = new Map<string, FeedEvent[]>();
    for (let i = feedEvents.length - 1; i >= 0; i--) {
      const e = feedEvents[i];
      // Resolve to specific agent (worktree-aware) instead of raw oracle name
      const agent = agentsRef.current.length > 0 ? resolveAgentFromFeed(e) : undefined;
      const key = agent ? agent.name.replace(/-oracle$/, "") : e.oracle;
      const arr = map.get(key) || [];
      if (arr.length < 5) { arr.push(e); map.set(key, arr); }
    }
    return map;
  }, [feedEvents, resolveAgentFromFeed]);

  return { sessions, agents, eventLog, addEvent, handleMessage, feedEvents, feedActive, agentFeedLog, teams };
}
