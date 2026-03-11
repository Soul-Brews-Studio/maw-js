import { memo, useMemo, useState, useEffect, useRef, useCallback } from "react";
import { HoverPreviewCard } from "./HoverPreviewCard";
import { StageSection } from "./StageSection";
import { AgentRow } from "./AgentRow";
import { roomStyle, PREVIEW_CARD } from "../lib/constants";
import { BottomStats } from "./BottomStats";
import { useFps } from "./FpsCounter";
import { useFleetStore, RECENT_TTL_MS, type RecentEntry } from "../lib/store";
import type { AgentState, Session, AgentEvent } from "../lib/types";
import { describeActivity, type FeedEvent } from "../lib/feed";

interface FleetGridProps {
  sessions: Session[];
  agents: AgentState[];
  saiyanTargets: Set<string>;
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
  eventLog: AgentEvent[];
  addEvent: (target: string, type: AgentEvent["type"], detail: string) => void;
  feedActive?: Map<string, FeedEvent>;
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
  sessions, agents, saiyanTargets, connected, send, onSelectAgent, eventLog, addEvent, feedActive,
}: FleetGridProps) {
  const fps = useFps();
  const observe = useVisibleTargets(send);
  const containerRef = useRef<HTMLDivElement>(null);

  // --- Zustand store ---
  const { recentMap, markBusy, pruneRecent, sortMode, setSortMode, grouped, toggleGrouped, collapsed, toggleCollapsed } = useFleetStore();
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

  const sorted = useMemo(() => sortRooms(sessions, sessionAgents, sortMode), [sessions, sessionAgents, sortMode]);

  type VRoom = { key: string; label: string; accent: string; floor: string; agents: AgentState[]; hasBusy: boolean; busyCount: number };
  const visualRooms = useMemo((): VRoom[] => {
    if (!grouped) {
      return sorted.map(s => {
        const st = roomStyle(s.name); const ra = sessionAgents.get(s.name) || []; const ba = ra.filter(a => a.status === "busy");
        return { key: s.name, label: s.name, accent: st.accent, floor: st.floor, agents: ra, hasBusy: ba.length > 0, busyCount: ba.length };
      });
    }
    const multi: VRoom[] = []; const soloAgents: AgentState[] = [];
    for (const s of sorted) {
      const st = roomStyle(s.name); const ra = sessionAgents.get(s.name) || []; const ba = ra.filter(a => a.status === "busy");
      if (ra.length <= 1) soloAgents.push(...ra);
      else multi.push({ key: s.name, label: s.name, accent: st.accent, floor: st.floor, agents: ra, hasBusy: ba.length > 0, busyCount: ba.length });
    }
    const result: VRoom[] = [];
    if (soloAgents.length > 0) {
      const sb = soloAgents.filter(a => a.status === "busy");
      result.push({ key: "_oracles", label: "Oracles", accent: "#7e57c2", floor: "#1a1428", agents: soloAgents, hasBusy: sb.length > 0, busyCount: sb.length });
    }
    result.push(...multi);
    return result;
  }, [sorted, sessionAgents, grouped]);

  // Resolve feed activity for an agent by oracle name
  const getFeedActivity = useCallback((agentName: string): string | null => {
    if (!feedActive) return null;
    const oracleName = agentName.replace(/-oracle$/, "");
    const event = feedActive.get(oracleName);
    if (!event) return null;
    return describeActivity(event);
  }, [feedActive]);

  const busyAgents = useMemo(() => agents.filter(a => a.status === "busy"), [agents]);
  const busyCount = busyAgents.length;
  const readyCount = agents.filter(a => a.status === "ready").length;
  const idleCount = agents.length - busyCount - readyCount;

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
      .slice(0, 10)
      .map(e => agentMap.get(e.target) || e);

    // Active first, then recently-gone
    return [...dedupBusy, ...recentGone];
  }, [agents, busyAgents, recentMap]);

  return (
    <div ref={containerRef} className="relative w-full min-h-screen" style={{ background: "#0a0a12" }}>
      {/* Summary bar */}
      <div className="max-w-5xl mx-auto flex items-center justify-between px-8 py-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-4 text-sm font-mono">
          <span className="text-white/30 text-[10px] tracking-[4px] uppercase">Fleet</span>
          <span className="text-white/60">{sessions.length} rooms</span>
          <span className="text-white/20">/</span>
          <span className="text-white/60">{agents.length} agents</span>
          <span className="text-white/20">/</span>
          <span style={{ color: fps >= 50 ? "#4caf50" : fps >= 30 ? "#ffa726" : "#ef5350" }}>{fps} fps</span>
        </div>
        <div className="flex items-center gap-5 text-sm font-mono">
          {busyCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_#ffa726] animate-pulse" />
              <span className="text-amber-400">{busyCount} busy</span>
            </span>
          )}
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_4px_#4caf50]" />
            <span className="text-emerald-400">{readyCount} ready</span>
          </span>
          {idleCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-white/20" />
              <span className="text-white/30">{idleCount} idle</span>
            </span>
          )}
          <span className="text-white/10">|</span>
          <div className="flex items-center rounded-lg overflow-hidden border border-white/[0.08]">
            <button className="px-3 py-1 text-[10px] font-mono cursor-pointer transition-colors duration-150"
              style={{ background: sortMode === "active" ? "rgba(251,191,36,0.15)" : "transparent", color: sortMode === "active" ? "#fbbf24" : "#64748B" }}
              onClick={() => setSortMode("active")}>Active first</button>
            <button className="px-3 py-1 text-[10px] font-mono cursor-pointer transition-colors duration-150"
              style={{ background: sortMode === "name" ? "rgba(255,255,255,0.08)" : "transparent", color: sortMode === "name" ? "#E2E8F0" : "#64748B" }}
              onClick={() => setSortMode("name")}>By room</button>
          </div>
        </div>
      </div>

      {/* Stage */}
      <StageSection
        busyAgents={busyAgents}
        recentlyActive={recentlyActive}
        saiyanTargets={saiyanTargets}
        showPreview={showPreview}
        hidePreview={hidePreview}
        onAgentClick={onAgentClick}
      />

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
                    saiyan={saiyanTargets.has(entry.target)} isLast={i === recentlyActive.length - 1}
                    agoLabel={agoLabel} feedActivity={getFeedActivity(agent.name)}
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
                      saiyan={saiyanTargets.has(agent.target)} isLast={i === vr.agents.length - 1}
                      feedActivity={getFeedActivity(agent.name)}
                      observe={observe} showPreview={showPreview} hidePreview={hidePreview} onAgentClick={onAgentClick}
                      send={send} onSendDone={onSendDone} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Group toggle */}
      <div className="max-w-5xl mx-auto flex justify-center py-4">
        <button className="text-[11px] font-mono px-4 py-2 rounded-lg border cursor-pointer transition-colors duration-150"
          style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)", color: "#94A3B8" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
          onClick={toggleGrouped}>
          {grouped ? "Show all rooms" : "Group solo oracles"}
        </button>
      </div>

      <BottomStats agents={agents} eventLog={eventLog} />

      {/* Hover Preview */}
      {hoverPreview && !pinnedPreview && (
        <div className="fixed pointer-events-auto" style={{ zIndex: 30, left: hoverPreview.pos.x, top: hoverPreview.pos.y, maxWidth: PREVIEW_CARD.width, animation: "fadeSlideIn 0.15s ease-out" }}
          onMouseEnter={keepPreview} onMouseLeave={hidePreview}>
          <HoverPreviewCard agent={hoverPreview.agent} roomLabel={hoverPreview.label} accent={hoverPreview.accent} />
        </div>
      )}

      {/* Backdrop */}
      {pinnedPreview && (
        <div className="fixed inset-0" style={{ zIndex: 35, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }} onClick={onPinnedClose} />
      )}

      {/* Pinned Preview */}
      {pinnedPreview && pinnedAnimPos && (
        <div ref={pinnedRef} className="fixed pointer-events-auto" style={{ zIndex: 40, left: pinnedAnimPos.left, top: pinnedAnimPos.top, maxWidth: PREVIEW_CARD.width }}>
          <HoverPreviewCard agent={pinnedPreview.agent} roomLabel={pinnedPreview.label} accent={pinnedPreview.accent}
            pinned send={send} onFullscreen={onPinnedFullscreen} onClose={onPinnedClose}
            eventLog={eventLog} addEvent={addEvent}
            externalInputBuf={getInputBuf(pinnedPreview.agent.target)}
            onInputBufChange={(val) => setInputBuf(pinnedPreview.agent.target, val)} />
        </div>
      )}

    </div>
  );
});
