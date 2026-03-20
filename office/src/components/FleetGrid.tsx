import { memo, useMemo, useState, useEffect, useRef, useCallback } from "react";
import { HoverPreviewCard } from "./HoverPreviewCard";
import { MiniPreview } from "./MiniPreview";
import { StageSection } from "./StageSection";
import { FootballPitch } from "./FootballPitch";
import { AgentRow } from "./AgentRow";
import { roomStyle, PREVIEW_CARD, guessCommand } from "../lib/constants";
import { BottomStats } from "./BottomStats";
import { useFps } from "./FpsCounter";
import { useFleetStore, RECENT_TTL_MS, type RecentEntry } from "../lib/store";
import type { AgentState, Session, AgentEvent } from "../lib/types";
import { describeActivity, type FeedEvent } from "../lib/feed";

export type FeedLogEntry = { text: string; ts: number; project?: string; eventType?: string };

/** Fleet-specific controls for StatusBar — reads from Zustand, takes agents for counts */
export function FleetControls({ agents, send }: { agents: AgentState[]; send: (msg: object) => void }) {
  const { sortMode, setSortMode } = useFleetStore();
  const busyCount = agents.filter(a => a.status === "busy").length;
  const readyCount = agents.filter(a => a.status === "ready").length;
  const idleCount = agents.length - busyCount - readyCount;

  const wakeAll = () => {
    for (const a of agents) {
      if (a.status === "idle") send({ type: "wake", target: a.target, command: guessCommand(a.name) });
    }
  };
  const sleepAll = () => {
    if (!confirm("Sleep all busy agents?")) return;
    for (const a of agents) {
      if (a.status === "busy") send({ type: "sleep", target: a.target });
    }
  };

  return (
    <>
      {busyCount > 0 && (
        <span className="flex items-center gap-1.5 text-xs font-mono whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_#ffa726] animate-pulse" />
          <span className="text-amber-400">{busyCount}</span>
        </span>
      )}
      <span className="flex items-center gap-1.5 text-xs font-mono whitespace-nowrap">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-emerald-400">{readyCount}</span>
      </span>
      {idleCount > 0 && (
        <span className="flex items-center gap-1.5 text-xs font-mono whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
          <span className="text-white/30">{idleCount}</span>
        </span>
      )}
      {idleCount > 0 && (
        <button className="px-2 py-1 text-[10px] font-mono font-bold rounded-md active:scale-95 transition-all whitespace-nowrap"
          style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}
          onClick={wakeAll} title="Wake all idle agents">Wake</button>
      )}
      {busyCount > 0 && (
        <button className="px-2 py-1 text-[10px] font-mono font-bold rounded-md active:scale-95 transition-all whitespace-nowrap"
          style={{ background: "rgba(251,191,36,0.1)", color: "#fbbf24" }}
          onClick={sleepAll} title="Sleep all busy agents">Sleep</button>
      )}
      <div className="flex items-center rounded-md overflow-hidden border border-white/[0.08]">
        <button className="px-2 py-0.5 text-[10px] font-mono transition-colors whitespace-nowrap"
          style={{ background: sortMode === "active" ? "rgba(251,191,36,0.15)" : "transparent", color: sortMode === "active" ? "#fbbf24" : "#64748B" }}
          onClick={() => setSortMode("active")}>Active</button>
        <button className="px-2 py-0.5 text-[10px] font-mono transition-colors whitespace-nowrap"
          style={{ background: sortMode === "name" ? "rgba(255,255,255,0.08)" : "transparent", color: sortMode === "name" ? "#E2E8F0" : "#64748B" }}
          onClick={() => setSortMode("name")}>Room</button>
      </div>
    </>
  );
}

interface FleetGridProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
  eventLog: AgentEvent[];
  addEvent: (target: string, type: AgentEvent["type"], detail: string) => void;
  feedActive?: Map<string, FeedEvent>;
  agentFeedLog?: Map<string, FeedEvent[]>;
}

/** Track visible agent targets via IntersectionObserver */
function useVisibleTargets(send: (msg: object) => void) {
  const visibleRef = useRef(new Set<string>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const syncToServer = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      send({ type: "subscribe-previews", targets: [...visibleRef.current] });
    }, 150);
  }, [send]);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const target = (entry.target as HTMLElement).dataset.target;
          if (!target) continue;
          if (entry.isIntersecting) {
            if (!visibleRef.current.has(target)) { visibleRef.current.add(target); changed = true; }
          } else {
            if (visibleRef.current.has(target)) { visibleRef.current.delete(target); changed = true; }
          }
        }
        if (changed) syncToServer();
      },
      { rootMargin: "100px" }
    );
    return () => { observerRef.current?.disconnect(); clearTimeout(debounceRef.current); };
  }, [syncToServer]);

  const observe = useCallback((el: HTMLElement | null, target: string) => {
    if (!el || !observerRef.current) return;
    el.dataset.target = target;
    observerRef.current.observe(el);
  }, []);

  return observe;
}

function sortRooms(sessions: Session[], agentMap: Map<string, AgentState[]>, mode: "active" | "name") {
  return [...sessions].sort((a, b) => {
    if (mode === "active") {
      const aBusy = (agentMap.get(a.name) || []).filter(ag => ag.status === "busy").length;
      const bBusy = (agentMap.get(b.name) || []).filter(ag => ag.status === "busy").length;
      if (aBusy !== bBusy) return bBusy - aBusy;
      const aLen = (agentMap.get(a.name) || []).length;
      const bLen = (agentMap.get(b.name) || []).length;
      if (aLen !== bLen) return bLen - aLen;
    }
    return a.name.localeCompare(b.name);
  });
}

export const FleetGrid = memo(function FleetGrid({
  sessions, agents, connected, send, onSelectAgent, eventLog, addEvent, feedActive, agentFeedLog,
}: FleetGridProps) {
  const fps = useFps();
  const observe = useVisibleTargets(send);
  const containerRef = useRef<HTMLDivElement>(null);

  // --- Zustand store ---
  const { recentMap, markBusy, pruneRecent, sortMode, setSortMode, collapsed, toggleCollapsed, sleptTargets, stageMode, toggleStageMode } = useFleetStore();
  const isCollapsed = useCallback((key: string) => collapsed.includes(key), [collapsed]);

  // Sync busy agents to store
  useEffect(() => {
    const busyAgentsData = agents.filter(a => a.status === "busy").map(a => ({ target: a.target, name: a.name, session: a.session }));
    if (busyAgentsData.length > 0) markBusy(busyAgentsData);
    pruneRecent();
  }, [agents, markBusy, pruneRecent]);

  // --- Preview state ---
  type PreviewInfo = { agent: AgentState; accent: string; label: string; pos: { x: number; y: number } };
  const [hoverPreview, setHoverPreview] = useState<PreviewInfo | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>();
  const [pinnedPreview, setPinnedPreview] = useState<PreviewInfo | null>(null);
  const [pinnedAnimPos, setPinnedAnimPos] = useState<{ left: number; top: number } | null>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [inputBufs, setInputBufs] = useState<Record<string, string>>({});
  const getInputBuf = useCallback((target: string) => inputBufs[target] || "", [inputBufs]);
  const setInputBuf = useCallback((target: string, val: string) => {
    setInputBufs(prev => ({ ...prev, [target]: val }));
  }, []);

  // --- Hover/click callbacks ---
  const showPreview = useCallback((agent: AgentState, accent: string, label: string, e: React.MouseEvent) => {
    if (pinnedPreview) return;
    clearTimeout(hoverTimeout.current);
    const cardW = PREVIEW_CARD.width;
    let x = e.clientX + 8;
    if (x + cardW > window.innerWidth - 8) x = e.clientX - cardW - 8;
    if (x < 8) x = 8;
    setHoverPreview({ agent, accent, label, pos: { x, y: e.clientY - 120 } });
  }, [pinnedPreview]);

  const hidePreview = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverPreview(null), 300);
  }, []);

  const keepPreview = useCallback(() => { clearTimeout(hoverTimeout.current); }, []);

  const onAgentClick = useCallback((agent: AgentState, accent: string, label: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pinnedPreview && pinnedPreview.agent.target === agent.target) { setPinnedPreview(null); return; }
    setPinnedPreview({ agent, accent, label, pos: { x: e.clientX, y: e.clientY } });
    setHoverPreview(null);
    send({ type: "subscribe", target: agent.target });
  }, [pinnedPreview, send]);

  // After sending via mic input, open pinned preview to watch the result
  const onSendDone = useCallback((agent: AgentState, accent: string, label: string) => {
    setPinnedPreview({ agent, accent, label, pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 } });
    setHoverPreview(null);
    send({ type: "subscribe", target: agent.target });
  }, [send]);

  useEffect(() => {
    if (pinnedPreview) {
      setPinnedAnimPos({
        left: (window.innerWidth - PREVIEW_CARD.width) / 2,
        top: Math.max(40, (window.innerHeight - PREVIEW_CARD.maxHeight) / 2),
      });
    } else { setPinnedAnimPos(null); }
  }, [pinnedPreview]);

  const onPinnedFullscreen = useCallback(() => {
    if (pinnedPreview) { const a = pinnedPreview.agent; setPinnedPreview(null); setTimeout(() => onSelectAgent(a), 150); }
  }, [pinnedPreview, onSelectAgent]);
  const onPinnedClose = useCallback(() => setPinnedPreview(null), []);

  // --- Computed data ---
  const sessionAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) { const arr = map.get(a.session) || []; arr.push(a); map.set(a.session, arr); }
    return map;
  }, [agents]);

  // Room actions
  const sleepRoom = useCallback((roomKey: string) => {
    const ra = sessionAgents.get(roomKey) || [];
    for (const a of ra) send({ type: "sleep", target: a.target });
  }, [sessionAgents, send]);

  const stopRoom = useCallback((roomKey: string) => {
    if (!confirm(`Stop all agents in this room?`)) return;
    const ra = sessionAgents.get(roomKey) || [];
    for (const a of ra) send({ type: "stop", target: a.target });
  }, [sessionAgents, send]);

  const sorted = useMemo(() => sortRooms(sessions, sessionAgents, sortMode), [sessions, sessionAgents, sortMode]);

  type VRoom = { key: string; label: string; accent: string; floor: string; agents: AgentState[]; hasBusy: boolean; busyCount: number };
  const visualRooms = useMemo((): VRoom[] => {
    return sorted.map(s => {
      const st = roomStyle(s.name); const ra = sessionAgents.get(s.name) || []; const ba = ra.filter(a => a.status === "busy");
      return { key: s.name, label: s.name, accent: st.accent, floor: st.floor, agents: ra, hasBusy: ba.length > 0, busyCount: ba.length };
    });
  }, [sorted, sessionAgents]);

  // Resolve per-agent feed log — primary oracle + worktree windows
  const getAgentFeedLog = useCallback((agentName: string): FeedLogEntry[] | null => {
    if (!agentFeedLog) return null;
    const oracleName = agentName.replace(/-oracle$/, "");
    const events = agentFeedLog.get(oracleName);
    if (!events || events.length === 0) return null;
    // For worktree windows (e.g. "homekeeper-statusline"), filter to matching project
    const suffix = agentName.replace(/^[^-]+-/, ""); // "statusline" from "homekeeper-statusline"
    const isWorktree = !agentName.endsWith("-oracle");
    const filtered = isWorktree
      ? events.filter(e => e.project.includes(suffix))
      : events;
    if (filtered.length === 0) return null;
    return filtered.map(e => ({ text: describeActivity(e), ts: e.ts, project: e.project, eventType: e.event }));
  }, [agentFeedLog]);

  const busyAgents = useMemo(() => agents.filter(a => a.status === "busy"), [agents]);

  // Recently active: busy agents first, then recently-gone from store
  // Deduplicated by agent name (same agent may have multiple tmux windows)
  const recentlyActive = useMemo((): (AgentState | RecentEntry)[] => {
    const agentMap = new Map(agents.map(a => [a.target, a]));
    const busyTargets = new Set(busyAgents.map(a => a.target));

    // Dedup busy agents by name — keep first (arbitrary, same agent)
    const seenNames = new Set<string>();
    const dedupBusy = busyAgents.filter(a => {
      if (seenNames.has(a.name)) return false;
      seenNames.add(a.name);
      return true;
    });

    // Recently-gone: in store but not currently busy, dedup by name (keep most recent)
    const recentByName = new Map<string, RecentEntry>();
    for (const e of Object.values(recentMap)) {
      if (busyTargets.has(e.target)) continue;
      const prev = recentByName.get(e.name);
      if (!prev || e.lastBusy > prev.lastBusy) recentByName.set(e.name, e);
    }
    const recentGone = [...recentByName.values()]
      .filter(e => !seenNames.has(e.name))
      .sort((a, b) => b.lastBusy - a.lastBusy)
      .slice(0, 5)
      .map(e => agentMap.get(e.target) || agents.find(a => a.name === e.name) || e);

    // Active first, then recently-gone
    return [...dedupBusy, ...recentGone];
  }, [agents, busyAgents, recentMap]);

  return (
    <div ref={containerRef} className="relative w-full min-h-screen" style={{ background: "#0a0a12" }}>
      {/* Toggle: Stage vs Pitch */}
      {stageMode === "pitch" ? (
        <FootballPitch
          agents={agents}
          recentMap={recentMap}
          showPreview={showPreview}
          hidePreview={hidePreview}
          onAgentClick={onAgentClick}
          onToggleView={toggleStageMode}
        />
      ) : (
        <>
          <div className="max-w-5xl mx-auto px-6 lg:px-8 flex justify-end pt-4">
            <button
              onClick={toggleStageMode}
              className="px-3 py-1 rounded-lg text-[11px] font-mono cursor-pointer hover:opacity-80 transition-opacity"
              style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              Switch to Pitch
            </button>
          </div>
          <StageSection
            busyAgents={busyAgents}
            recentlyActive={recentlyActive}
            recentMap={recentMap}
            getAgentFeedLog={getAgentFeedLog}
            showPreview={showPreview}
            hidePreview={hidePreview}
            onAgentClick={onAgentClick}
          />
        </>
      )}

      {/* Rooms */}
      <div className="max-w-5xl mx-auto flex flex-col px-6 lg:px-8 py-6 gap-4">
        {/* Recently Active group — always visible */}
        <section className="rounded-2xl overflow-hidden" style={{ background: "#12121c", border: "1px solid rgba(251,191,36,0.15)", boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}>
          <div className="flex items-center gap-5 px-6 py-4 cursor-pointer select-none" style={{ background: "rgba(251,191,36,0.03)" }}
            onClick={() => toggleCollapsed("_recent")} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapsed("_recent"); } }}>
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: "#fbbf24", boxShadow: "0 0 6px #fbbf24" }} />
            <h3 className="text-base font-bold tracking-[4px] uppercase" style={{ color: "#fbbf24" }}>Recently Active</h3>
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md" style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24" }}>{recentlyActive.length}</span>
            <svg width={16} height={16} viewBox="0 0 16 16" fill="none" className="ml-auto flex-shrink-0 transition-transform duration-200"
              style={{ transform: isCollapsed("_recent") ? "rotate(-90deg)" : "rotate(0deg)" }}>
              <path d="M4 6l4 4 4-4" stroke="#fbbf24" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.5} />
            </svg>
          </div>
          {!isCollapsed("_recent") && <div className="h-[1px]" style={{ background: "rgba(251,191,36,0.12)" }} />}
          {!isCollapsed("_recent") && (
            <div className="flex flex-col">
              {recentlyActive.length === 0 && (
                <div className="px-6 py-4 text-[13px] font-mono text-white/20">No recent activity yet</div>
              )}
              {recentlyActive.map((entry, i) => {
                const rs = roomStyle(entry.session);
                const isBusyNow = "status" in entry && (entry as AgentState).status === "busy";
                const lastBusy = recentMap[entry.target]?.lastBusy || 0;
                const ago = Math.round((Date.now() - lastBusy) / 1000);
                const agoLabel = isBusyNow ? undefined : (ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`);
                // Build a full AgentState — use live data if available, otherwise fake from stored metadata
                const agent: AgentState = "status" in entry
                  ? entry as AgentState
                  : { target: entry.target, name: entry.name, session: entry.session, windowIndex: 0, active: false, preview: "", status: "idle" };
                return (
                  <AgentRow key={`recent-${entry.target}`} agent={agent} accent={rs.accent} roomLabel={rs.label}
                    isLast={i === recentlyActive.length - 1}
                    featured={i === 0} agoLabel={agoLabel} feedLog={getAgentFeedLog(agent.name)}
                    slept={sleptTargets.includes(entry.target)} alignWidth={96}
                    observe={observe} showPreview={showPreview} hidePreview={hidePreview} onAgentClick={onAgentClick}
                    send={send} onSendDone={onSendDone} />
                );
              })}
            </div>
          )}
        </section>

        {/* Room cards */}
        {visualRooms.map((vr) => {
          const style = { accent: vr.accent, floor: vr.floor };
          return (
            <section key={vr.key} className="rounded-2xl overflow-hidden"
              style={{ background: "#12121c", border: `1px solid ${vr.hasBusy ? style.accent + "40" : style.accent + "18"}`, boxShadow: vr.hasBusy ? `0 0 24px ${style.accent}12` : "0 2px 8px rgba(0,0,0,0.3)" }}
              aria-label={`${vr.label} room with ${vr.agents.length} agents`}>
              <div className="flex items-center gap-5 px-6 py-4 cursor-pointer transition-colors duration-150 select-none" style={{ background: `${style.accent}08` }}
                onClick={() => toggleCollapsed(vr.key)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapsed(vr.key); } }}>
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: vr.hasBusy ? "#ffa726" : "#22C55E", boxShadow: vr.hasBusy ? "0 0 10px #ffa726" : "0 0 6px #22C55E" }} />
                <h3 className="text-base font-bold tracking-[4px] uppercase" style={{ color: style.accent }}>{vr.label}</h3>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md" style={{ background: `${style.accent}20`, color: style.accent }}>{vr.agents.length}</span>
                {vr.hasBusy && <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-amber-400/15 text-amber-400">{vr.busyCount} busy</span>}
                {/* Room controls */}
                <div className="flex items-center gap-1.5 ml-2">
                  <button title="Sleep all (Ctrl+C)" onClick={(e) => { e.stopPropagation(); sleepRoom(vr.key); }}
                    className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all active:scale-90"
                    style={{ background: "rgba(251,191,36,0.12)" }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="#fbbf24"><rect x={6} y={5} width={4} height={14} rx={1} /><rect x={14} y={5} width={4} height={14} rx={1} /></svg>
                  </button>
                  <button title="Stop room" onClick={(e) => { e.stopPropagation(); stopRoom(vr.key); }}
                    className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer transition-all active:scale-90"
                    style={{ background: "rgba(239,68,68,0.12)" }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="#ef4444"><rect x={5} y={5} width={14} height={14} rx={2} /></svg>
                  </button>
                </div>
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none" className="ml-auto flex-shrink-0 transition-transform duration-200"
                  style={{ transform: isCollapsed(vr.key) ? "rotate(-90deg)" : "rotate(0deg)" }}>
                  <path d="M4 6l4 4 4-4" stroke={style.accent} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.5} />
                </svg>
              </div>
              {!isCollapsed(vr.key) && <div className="h-[1px]" style={{ background: `${style.accent}25` }} />}
              {!isCollapsed(vr.key) && (
                <div className="flex flex-col">
                  {vr.agents.map((agent, i) => (
                    <AgentRow key={agent.target} agent={agent} accent={style.accent} roomLabel={vr.label}
                      isLast={i === vr.agents.length - 1}
                      feedLog={getAgentFeedLog(agent.name)}
                      slept={sleptTargets.includes(agent.target)}
                      observe={observe} showPreview={showPreview} hidePreview={hidePreview} onAgentClick={onAgentClick}
                      send={send} onSendDone={onSendDone} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <BottomStats agents={agents} eventLog={eventLog} />

      {/* Hover Preview — compact mini card */}
      {hoverPreview && !pinnedPreview && (
        <div className="fixed pointer-events-auto" style={{ zIndex: 30, left: hoverPreview.pos.x, top: hoverPreview.pos.y, animation: "fadeSlideIn 0.15s ease-out" }}
          onMouseEnter={keepPreview} onMouseLeave={hidePreview}
          onClick={(e) => onAgentClick(hoverPreview.agent, hoverPreview.accent, hoverPreview.label, e)}>
          <MiniPreview agent={hoverPreview.agent} accent={hoverPreview.accent} roomLabel={hoverPreview.label} />
        </div>
      )}

      {/* Backdrop */}
      {pinnedPreview && (
        <div className="fixed inset-0" style={{ zIndex: 35, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }} onClick={onPinnedClose} />
      )}

      {/* Pinned Preview */}
      {pinnedPreview && pinnedAnimPos && (
        <div ref={pinnedRef} className="fixed pointer-events-auto" style={{ zIndex: 40, left: pinnedAnimPos.left, top: pinnedAnimPos.top, maxWidth: PREVIEW_CARD.width }}>
          <HoverPreviewCard key={pinnedPreview.agent.target} agent={pinnedPreview.agent} roomLabel={pinnedPreview.label} accent={pinnedPreview.accent}
            pinned send={send} onFullscreen={onPinnedFullscreen} onClose={onPinnedClose}
            eventLog={eventLog} addEvent={addEvent}
            externalInputBuf={getInputBuf(pinnedPreview.agent.target)}
            onInputBufChange={(val) => setInputBuf(pinnedPreview.agent.target, val)} />
        </div>
      )}

    </div>
  );
});
