import { memo, useMemo } from "react";
import { roomStyle } from "../lib/constants";
import { AgentCard } from "./AgentCard";
import type { AgentState, Session } from "../lib/types";

interface RoomGridProps {
  sessions: Session[];
  agents: AgentState[];
  onSelectAgent: (agent: AgentState) => void;
}

export const RoomGrid = memo(function RoomGrid({ sessions, agents, onSelectAgent }: RoomGridProps) {
  const sessionAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) {
      const arr = map.get(a.session) || [];
      arr.push(a);
      map.set(a.session, arr);
    }
    return map;
  }, [agents]);

  const busyCount = agents.filter(a => a.status === "busy").length;

  return (
    <div className="max-w-[1200px] mx-auto px-6 pt-8 pb-12">
      {/* Power bar */}
      <div className="flex items-center gap-3 mb-5 px-1">
        <span className="text-[10px] text-white/50 tracking-widest uppercase">Power Level</span>
        <div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.min(100, (busyCount / Math.max(1, agents.length)) * 100)}%`,
              background: busyCount > 5 ? "#ef5350" : busyCount > 2 ? "#ffa726" : "#4caf50",
            }}
          />
        </div>
        <span className="text-[10px] text-white/50 tabular-nums">{busyCount}/{agents.length}</span>
      </div>

      {/* Room grid — full width, 3 columns on wide screens */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {sessions.map((s) => {
          const style = roomStyle(s.name);
          const roomAgents = sessionAgents.get(s.name) || [];
          const hasBusy = roomAgents.some(a => a.status === "busy");

          return (
            <div
              key={s.name}
              className="rounded-3xl border backdrop-blur-xl transition-all duration-300 hover:scale-[1.01]"
              style={{
                background: `${style.floor}88`,
                borderColor: hasBusy ? `${style.accent}40` : `${style.accent}12`,
                boxShadow: hasBusy
                  ? `0 8px 32px ${style.accent}15, 0 0 60px ${style.accent}08, inset 0 1px 0 rgba(255,255,255,0.05)`
                  : `0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)`,
              }}
            >
              {/* Room header */}
              <div
                className="flex items-center justify-between px-5 py-3 rounded-t-3xl border-b"
                style={{ background: `${style.wall}dd`, borderColor: `${style.accent}15` }}
              >
                <span
                  className="text-xs font-bold tracking-[2px] uppercase"
                  style={{ color: style.accent }}
                >
                  {style.label}
                </span>
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-md"
                  style={{ color: style.accent, background: `${style.accent}15` }}
                >
                  {roomAgents.length}
                </span>
              </div>

              {/* Accent line */}
              <div className="h-[2px] opacity-50" style={{ background: style.accent }} />

              {/* Agent grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 p-5 min-h-[140px]">
                {roomAgents.map((agent) => (
                  <AgentCard
                    key={agent.target}
                    agent={agent}
                    accent={style.accent}
                    onClick={() => onSelectAgent(agent)}
                  />
                ))}
                {roomAgents.length === 0 && (
                  <div className="col-span-full text-center text-[10px] text-white/30 py-4">
                    Empty room
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
