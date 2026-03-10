import { memo, useMemo, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roomStyle } from "../lib/constants";
import { BottomStats } from "./BottomStats";
import type { AgentState, Session, AgentEvent } from "../lib/types";

interface FleetGridProps {
  sessions: Session[];
  agents: AgentState[];
  saiyanTargets: Set<string>;
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
  eventLog: AgentEvent[];
  addEvent: (target: string, type: AgentEvent["type"], detail: string) => void;
}

function sortRooms(sessions: Session[], agentMap: Map<string, AgentState[]>) {
  return [...sessions].sort((a, b) => {
    const aAgents = agentMap.get(a.name) || [];
    const bAgents = agentMap.get(b.name) || [];
    const aBusy = aAgents.filter(ag => ag.status === "busy").length;
    const bBusy = bAgents.filter(ag => ag.status === "busy").length;
    if (aBusy !== bBusy) return bBusy - aBusy;
    if (aAgents.length !== bAgents.length) return bAgents.length - aAgents.length;
    return a.name.localeCompare(b.name);
  });
}

export const FleetGrid = memo(function FleetGrid({
  sessions,
  agents,
  saiyanTargets,
  connected,
  send,
  onSelectAgent,
  eventLog,
  addEvent,
}: FleetGridProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (name: string) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });
  const [grouped, setGrouped] = useState(true);

  const sessionAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) {
      const arr = map.get(a.session) || [];
      arr.push(a);
      map.set(a.session, arr);
    }
    return map;
  }, [agents]);

  const sorted = useMemo(() => sortRooms(sessions, sessionAgents), [sessions, sessionAgents]);

  // Visual grouping: merge single-agent rooms into "Oracles"
  type VRoom = { key: string; label: string; accent: string; floor: string; agents: AgentState[]; hasBusy: boolean; busyCount: number };
  const visualRooms = useMemo((): VRoom[] => {
    if (!grouped) {
      return sorted.map(s => {
        const style = roomStyle(s.name);
        const ra = sessionAgents.get(s.name) || [];
        const ba = ra.filter(a => a.status === "busy");
        return { key: s.name, label: style.label, accent: style.accent, floor: style.floor, agents: ra, hasBusy: ba.length > 0, busyCount: ba.length };
      });
    }
    const multi: VRoom[] = [];
    const soloAgents: AgentState[] = [];
    for (const s of sorted) {
      const style = roomStyle(s.name);
      const ra = sessionAgents.get(s.name) || [];
      const ba = ra.filter(a => a.status === "busy");
      if (ra.length <= 1) {
        soloAgents.push(...ra);
      } else {
        multi.push({ key: s.name, label: style.label, accent: style.accent, floor: style.floor, agents: ra, hasBusy: ba.length > 0, busyCount: ba.length });
      }
    }
    const result: VRoom[] = [];
    if (soloAgents.length > 0) {
      const soloBusy = soloAgents.filter(a => a.status === "busy");
      result.push({ key: "_oracles", label: "Oracles", accent: "#7e57c2", floor: "#1a1428", agents: soloAgents, hasBusy: soloBusy.length > 0, busyCount: soloBusy.length });
    }
    result.push(...multi);
    return result;
  }, [sorted, sessionAgents, grouped]);

  const busyCount = agents.filter(a => a.status === "busy").length;
  const readyCount = agents.filter(a => a.status === "ready").length;
  const idleCount = agents.length - busyCount - readyCount;

  return (
    <div className="relative w-full min-h-screen" style={{ background: "#0a0a12" }}>
      {/* Summary */}
      <div className="max-w-5xl mx-auto flex items-center justify-between px-8 py-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-4 text-sm font-mono">
          <span className="text-white/30 text-[10px] tracking-[4px] uppercase">Fleet</span>
          <span className="text-white/60">{sessions.length} rooms</span>
          <span className="text-white/20">/</span>
          <span className="text-white/60">{agents.length} agents</span>
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
        </div>
      </div>

      {/* Rooms */}
      <div className="max-w-5xl mx-auto flex flex-col px-6 lg:px-8 py-6 gap-4">
        {visualRooms.map((vr) => {
          const roomAgents = vr.agents;
          const hasBusy = vr.hasBusy;
          const style = { accent: vr.accent, floor: vr.floor };

          return (
            <section
              key={vr.key}
              className="rounded-2xl overflow-hidden"
              style={{
                background: "#12121c",
                border: `1px solid ${hasBusy ? style.accent + "40" : style.accent + "18"}`,
                boxShadow: hasBusy ? `0 0 24px ${style.accent}12` : "0 2px 8px rgba(0,0,0,0.3)",
              }}
              aria-label={`${vr.label} room with ${roomAgents.length} agents`}
            >
              {/* Room header — clickable to collapse */}
              <div
                className="flex items-center gap-5 px-6 py-4 cursor-pointer transition-colors duration-150 select-none"
                style={{ background: `${style.accent}08` }}
                onClick={() => toggle(vr.key)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(vr.key); } }}
              >
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    background: hasBusy ? "#ffa726" : "#22C55E",
                    boxShadow: hasBusy ? "0 0 10px #ffa726" : "0 0 6px #22C55E",
                  }}
                />
                <h3
                  className="text-base font-bold tracking-[4px] uppercase"
                  style={{ color: style.accent }}
                >
                  {vr.label}
                </h3>
                <span
                  className="text-xs font-mono font-bold px-2.5 py-1 rounded-md"
                  style={{ background: `${style.accent}20`, color: style.accent }}
                >
                  {roomAgents.length}
                </span>
                {hasBusy && (
                  <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-amber-400/15 text-amber-400">
                    {vr.busyCount} busy
                  </span>
                )}
                <svg
                  width={16} height={16} viewBox="0 0 16 16" fill="none"
                  className="ml-auto flex-shrink-0 transition-transform duration-200"
                  style={{ transform: collapsed.has(vr.key) ? "rotate(-90deg)" : "rotate(0deg)" }}
                >
                  <path d="M4 6l4 4 4-4" stroke={style.accent} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.5} />
                </svg>
              </div>

              {/* Accent bar */}
              {!collapsed.has(vr.key) && <div className="h-[1px]" style={{ background: `${style.accent}25` }} />}

              {/* Agent rows */}
              {!collapsed.has(vr.key) && <div className="flex flex-col">
                {roomAgents.map((agent, i) => {
                  const isBusy = agent.status === "busy";
                  const isSaiyan = saiyanTargets.has(agent.target);
                  const isLast = i === roomAgents.length - 1;
                  return (
                    <div
                      key={agent.target}
                      className="flex items-center gap-5 px-6 py-3.5 cursor-pointer transition-all duration-150"
                      style={{
                        borderBottom: !isLast ? `1px solid rgba(255,255,255,0.04)` : "none",
                        background: isBusy ? `${style.accent}06` : "transparent",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = `${style.accent}10`; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = isBusy ? `${style.accent}06` : "transparent"; }}
                      onClick={() => onSelectAgent(agent)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${agent.name} - ${agent.status}`}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectAgent(agent); } }}
                    >
                      {/* Avatar */}
                      <div className="w-14 h-14 flex-shrink-0" style={{ overflow: "visible" }}>
                        <svg viewBox="-40 -50 80 80" width={56} height={56} overflow="visible">
                          <AgentAvatar
                            name={agent.name}
                            target={agent.target}
                            status={agent.status}
                            preview={agent.preview}
                            accent={style.accent}
                            saiyan={isSaiyan}
                            onClick={() => onSelectAgent(agent)}
                          />
                        </svg>
                      </div>

                      {/* Info column */}
                      <div className="flex flex-col gap-1 flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                          {/* Name */}
                          <span
                            className="text-[15px] font-semibold truncate"
                            style={{ color: isBusy ? style.accent : "#E2E8F0" }}
                          >
                            {agent.name.replace(/-oracle$/, "").replace(/-/g, " ")}
                          </span>

                          {/* Status badge */}
                          <span
                            className="text-[11px] font-mono px-2.5 py-1 rounded-md flex-shrink-0"
                            style={{
                              background: isBusy ? "#ffa72620" : agent.status === "ready" ? "#22C55E18" : "rgba(255,255,255,0.06)",
                              color: isBusy ? "#ffa726" : agent.status === "ready" ? "#22C55E" : "#94A3B8",
                            }}
                          >
                            {agent.status}
                          </span>

                          {isSaiyan && (
                            <span className="text-[10px] font-mono px-2.5 py-1 rounded-md bg-amber-400/20 text-amber-400 flex-shrink-0">
                              SAIYAN
                            </span>
                          )}
                        </div>

                        {/* Activity preview */}
                        <span className="text-[13px] truncate" style={{ color: "#64748B" }}>
                          {agent.preview?.slice(0, 80) || "\u00a0"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>}
            </section>
          );
        })}
      </div>

      {/* Group toggle */}
      <div className="max-w-5xl mx-auto flex justify-center py-4">
        <button
          className="text-[11px] font-mono px-4 py-2 rounded-lg border cursor-pointer transition-colors duration-150"
          style={{
            background: "rgba(255,255,255,0.03)",
            borderColor: "rgba(255,255,255,0.08)",
            color: "#94A3B8",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
          onClick={() => setGrouped(g => !g)}
        >
          {grouped ? "Show all rooms" : "Group solo oracles"}
        </button>
      </div>

      <BottomStats agents={agents} eventLog={eventLog} />
    </div>
  );
});
