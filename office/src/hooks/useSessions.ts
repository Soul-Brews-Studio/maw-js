import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session, AgentState, PaneStatus, AgentEvent } from "../lib/types";
import { stripAnsi } from "../lib/ansi";
import { playSaiyanSound } from "../lib/sounds";
import { agentSortKey } from "../lib/constants";
import { useFleetStore } from "../lib/store";
import { activeOracles, describeActivity, type FeedEvent, type FeedEventType } from "../lib/feed";

const BUSY_TIMEOUT = 15_000; // 15s without feed → ready
const IDLE_TIMEOUT = 60_000; // 60s without feed → idle

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [captureData, setCaptureData] = useState<Record<string, { preview: string; status: PaneStatus }>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const lastSoundTime = useRef(0);
  const [saiyanTargets, setSaiyanTargets] = useState<Set<string>>(new Set());
  const saiyanTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saiyanSourceTimers = useRef<Record<string, { hash: number; feed: number }>>({});
  const [saiyanSources, setSaiyanSources] = useState<Record<string, string>>({});
  const [eventLog, setEventLog] = useState<AgentEvent[]>([]);
  const MAX_EVENTS = 200;

  // Oracle feed state
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
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

  // Feed-triggered Saiyan
  const agentsRef = useRef<AgentState[]>([]);
  const SAIYAN_FEED_EVENTS = new Set<FeedEventType>(["PreToolUse", "UserPromptSubmit", "SubagentStart"]);
  const SAIYAN_DURATION = 10_000;

  const extendSaiyan = useCallback((target: string, agentName: string, session: string, source: "H" | "F") => {
    const now = Date.now();
    if (now - lastSoundTime.current > 60000) {
      lastSoundTime.current = now;
      playSaiyanSound();
    }
    clearTimeout(saiyanTimers.current[target]);
    setSaiyanTargets(prev => new Set(prev).add(target));
    saiyanTimers.current[target] = setTimeout(() => {
      setSaiyanTargets(prev => { const n = new Set(prev); n.delete(target); return n; });
      setSaiyanSources(prev => { const n = { ...prev }; delete n[target]; return n; });
      delete saiyanSourceTimers.current[target];
    }, SAIYAN_DURATION);
    const st = saiyanSourceTimers.current[target] || { hash: 0, feed: 0 };
    if (source === "H") st.hash = now; else st.feed = now;
    saiyanSourceTimers.current[target] = st;
    const hashActive = now - st.hash < 15000;
    const feedActive = now - st.feed < 15000;
    const label = hashActive && feedActive ? "HF" : hashActive ? "H" : "F";
    setSaiyanSources(prev => prev[target] === label ? prev : { ...prev, [target]: label });
    markBusy([{ target, name: agentName, session }]);
  }, [markBusy]);

  const SAIYAN_STOP_EVENTS = new Set<FeedEventType>(["Stop", "SessionEnd", "TaskCompleted"]);

  const dropSaiyan = useCallback((target: string) => {
    clearTimeout(saiyanTimers.current[target]);
    setSaiyanTargets(prev => {
      if (!prev.has(target)) return prev;
      const n = new Set(prev); n.delete(target); return n;
    });
    setSaiyanSources(prev => { const n = { ...prev }; delete n[target]; return n; });
    delete saiyanSourceTimers.current[target];
  }, []);

  // --- Feed-based status tracking ---
  // oracle name → last feed timestamp
  const feedLastSeen = useRef<Record<string, number>>({});

  const FEED_BUSY_EVENTS = new Set<FeedEventType>(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SubagentStart", "PostToolUseFailure"]);
  const FEED_STOP_EVENTS = new Set<FeedEventType>(["Stop", "SessionEnd", "TaskCompleted", "Notification"]);

  /** Resolve feed event → agent. Uses project field for worktree-aware matching. */
  const resolveAgentFromFeed = useCallback((event: FeedEvent): AgentState | undefined => {
    // project like "hermes-oracle.wt-1-bitkub" → window name "hermes-bitkub"
    const project = event.project;
    const wtMatch = project.match(/\.wt-\d+-(.+)$/);
    if (wtMatch) {
      const windowName = `${event.oracle}-${wtMatch[1]}`;
      const agent = agentsRef.current.find(a => a.name === windowName);
      if (agent) return agent;
    }
    // Fallback: match by oracle name (main window)
    return agentsRef.current.find(a => a.name === `${event.oracle}-oracle`);
  }, []);

  const updateStatusFromFeed = useCallback((event: FeedEvent) => {
    const agent = resolveAgentFromFeed(event);
    if (!agent) return;

    const target = agent.target;

    if (FEED_BUSY_EVENTS.has(event.event)) {
      feedLastSeen.current[target] = Date.now();
      setCaptureData(prev => {
        const existing = prev[target];
        if (existing?.status === "busy") return prev;
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

          if (existing.status === "busy" && lastSeen > 0 && now - lastSeen > BUSY_TIMEOUT) {
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

  const triggerFeedSaiyan = useCallback((event: FeedEvent) => {
    const agent = resolveAgentFromFeed(event);
    if (!agent) return;

    if (SAIYAN_STOP_EVENTS.has(event.event)) {
      dropSaiyan(agent.target);
      return;
    }
    if (SAIYAN_FEED_EVENTS.has(event.event)) {
      console.debug(`[feed] saiyan: ${event.oracle} event=${event.event}`);
      extendSaiyan(agent.target, agent.name, agent.session, "F");
    }
  }, [extendSaiyan, dropSaiyan, resolveAgentFromFeed]);

  const handleMessage = useCallback((data: any) => {
    if (data.type === "sessions") {
      setSessions(data.sessions);
    } else if (data.type === "recent") {
      const agents: { target: string; name: string; session: string }[] = data.agents || [];
      if (agents.length > 0) markBusy(agents);
    } else if (data.type === "feed") {
      const feedEvent = data.event as FeedEvent;
      setFeedEvents(prev => {
        const next = [...prev, feedEvent];
        return next.length > MAX_FEED ? next.slice(-MAX_FEED) : next;
      });
      triggerFeedSaiyan(feedEvent);
      updateStatusFromFeed(feedEvent);
    } else if (data.type === "feed-history") {
      const events = (data.events as FeedEvent[]).slice(-MAX_FEED);
      setFeedEvents(events);
      // Set initial status from recent feed events
      for (const e of events) updateStatusFromFeed(e);
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
      else if (data.action === "wake" || data.action === "spawn") clearSlept(data.target);
    }
  }, []);

  // Derive flat agent list
  const agents: AgentState[] = useMemo(() => {
    const list = sessions.flatMap((s) =>
      s.windows.map((w) => {
        const key = `${s.name}:${w.index}`;
        const cd = captureData[key];
        return {
          target: key,
          name: w.name,
          session: s.name,
          windowIndex: w.index,
          active: w.active,
          preview: cd?.preview || "",
          status: cd?.status || "idle",
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
      const arr = map.get(e.oracle) || [];
      if (arr.length < 5) { arr.push(e); map.set(e.oracle, arr); }
    }
    return map;
  }, [feedEvents]);

  return { sessions, agents, saiyanTargets, saiyanSources, eventLog, addEvent, handleMessage, feedEvents, feedActive, agentFeedLog };
}
