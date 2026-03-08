import { memo, useMemo, useState, useCallback } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roomStyle } from "../lib/constants";
import type { AgentState, Session } from "../lib/types";

interface MissionControlProps {
  sessions: Session[];
  agents: AgentState[];
  saiyanTargets: Set<string>;
  connected: boolean;
  onSelectAgent: (agent: AgentState) => void;
}

export const MissionControl = memo(function MissionControl({
  sessions,
  agents,
  saiyanTargets,
  connected,
  onSelectAgent,
}: MissionControlProps) {
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  const busyCount = agents.filter((a) => a.status === "busy").length;
  const readyCount = agents.filter((a) => a.status === "ready").length;
  const idleCount = agents.filter((a) => a.status === "idle").length;

  // Group agents by session
  const sessionAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) {
      const arr = map.get(a.session) || [];
      arr.push(a);
      map.set(a.session, arr);
    }
    return map;
  }, [agents]);

  // Layout: arrange sessions in a hex-ish grid
  // Each session is a cluster of agents
  const layout = useMemo(() => {
    const sessionList = sessions.map((s) => ({
      session: s,
      agents: sessionAgents.get(s.name) || [],
      style: roomStyle(s.name),
    }));

    // Calculate positions in a radial layout
    const cx = 600, cy = 400;
    const radius = Math.min(250, 120 + sessionList.length * 20);

    return sessionList.map((s, i) => {
      const angle = (i / sessionList.length) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      return { ...s, x, y };
    });
  }, [sessions, sessionAgents]);

  const onAgentClick = useCallback(
    (agent: AgentState) => onSelectAgent(agent),
    [onSelectAgent]
  );

  return (
    <div className="relative w-full h-screen overflow-hidden" style={{ background: "#020208" }}>
      {/* SVG Mission Control */}
      <svg
        viewBox="0 0 1200 800"
        className="w-full h-full"
        style={{ maxHeight: "100vh" }}
      >
        <defs>
          <radialGradient id="mc-bg-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1a1a3e" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#020208" stopOpacity={0} />
          </radialGradient>
          <filter id="mc-glow">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" />
          </filter>
        </defs>

        {/* Background glow */}
        <circle cx={600} cy={400} r={500} fill="url(#mc-bg-glow)" />

        {/* Grid lines */}
        {Array.from({ length: 13 }, (_, i) => (
          <line key={`vl-${i}`} x1={i * 100} y1={0} x2={i * 100} y2={800}
            stroke="#ffffff" strokeWidth={0.3} opacity={0.03} />
        ))}
        {Array.from({ length: 9 }, (_, i) => (
          <line key={`hl-${i}`} x1={0} y1={i * 100} x2={1200} y2={i * 100}
            stroke="#ffffff" strokeWidth={0.3} opacity={0.03} />
        ))}

        {/* Orbital rings */}
        <circle cx={600} cy={400} r={120} fill="none" stroke="#26c6da" strokeWidth={0.5} opacity={0.08}
          strokeDasharray="4 8" />
        <circle cx={600} cy={400} r={250} fill="none" stroke="#7e57c2" strokeWidth={0.5} opacity={0.06}
          strokeDasharray="6 12" />
        <circle cx={600} cy={400} r={380} fill="none" stroke="#ffa726" strokeWidth={0.5} opacity={0.04}
          strokeDasharray="8 16" />

        {/* Center hub */}
        <circle cx={600} cy={400} r={40} fill="none" stroke="#26c6da" strokeWidth={1} opacity={0.15} />
        <circle cx={600} cy={400} r={6} fill="#26c6da" opacity={0.4} />
        <text x={600} y={370} textAnchor="middle" fill="#26c6da" fontSize={10} opacity={0.5}
          fontFamily="'SF Mono', monospace" letterSpacing={4}>MISSION CONTROL</text>

        {/* Connection lines from hub to sessions */}
        {layout.map((s) => (
          <line key={`line-${s.session.name}`}
            x1={600} y1={400} x2={s.x} y2={s.y}
            stroke={s.style.accent} strokeWidth={0.5} opacity={0.08}
            strokeDasharray="2 6"
          />
        ))}

        {/* Session clusters */}
        {layout.map((s) => {
          const agentCount = s.agents.length;
          const clusterRadius = Math.max(50, 20 + agentCount * 12);
          const hasBusy = s.agents.some((a) => a.status === "busy");

          return (
            <g key={s.session.name}>
              {/* Session zone */}
              <circle cx={s.x} cy={s.y} r={clusterRadius}
                fill={`${s.style.floor}cc`}
                stroke={s.style.accent}
                strokeWidth={hasBusy ? 1.5 : 0.5}
                opacity={hasBusy ? 0.8 : 0.4}
                style={hasBusy ? { animation: "room-pulse 2s ease-in-out infinite" } : {}}
              />

              {/* Session label */}
              <text
                x={s.x} y={s.y - clusterRadius - 8}
                textAnchor="middle"
                fill={s.style.accent}
                fontSize={9}
                fontWeight="bold"
                fontFamily="'SF Mono', monospace"
                letterSpacing={2}
                opacity={0.7}
              >
                {s.style.label.toUpperCase()}
              </text>

              {/* Agent count badge */}
              <text
                x={s.x} y={s.y + clusterRadius + 14}
                textAnchor="middle"
                fill={s.style.accent}
                fontSize={8}
                fontFamily="'SF Mono', monospace"
                opacity={0.35}
              >
                {agentCount} agent{agentCount !== 1 ? "s" : ""}
              </text>

              {/* Agents within cluster */}
              {s.agents.map((agent, ai) => {
                const agentAngle = (ai / Math.max(1, agentCount)) * Math.PI * 2 - Math.PI / 2;
                const agentRadius = agentCount === 1 ? 0 : Math.min(clusterRadius - 30, 25 + agentCount * 4);
                const ax = s.x + Math.cos(agentAngle) * agentRadius;
                const ay = s.y + Math.sin(agentAngle) * agentRadius;
                const isHovered = hoveredAgent === agent.target;
                const scale = isHovered ? 0.55 : 0.45;

                return (
                  <g key={agent.target} transform={`translate(${ax}, ${ay})`}>
                    <g
                      transform={`scale(${scale})`}
                      onMouseEnter={() => setHoveredAgent(agent.target)}
                      onMouseLeave={() => setHoveredAgent(null)}
                      style={{ transition: "transform 0.2s" }}
                    >
                      <AgentAvatar
                        name={agent.name}
                        target={agent.target}
                        status={agent.status}
                        preview={agent.preview}
                        accent={s.style.accent}
                        saiyan={saiyanTargets.has(agent.target)}
                        onClick={() => onAgentClick(agent)}
                      />
                    </g>
                    {/* Agent name (below) */}
                    <text
                      y={24}
                      textAnchor="middle"
                      fill={isHovered ? s.style.accent : "#ffffff"}
                      fontSize={isHovered ? 8 : 7}
                      fontFamily="'SF Mono', monospace"
                      opacity={isHovered ? 0.9 : 0.4}
                      style={{ transition: "all 0.2s", cursor: "pointer" }}
                      onClick={() => onAgentClick(agent)}
                    >
                      {agent.name.replace(/-oracle$/, "").replace(/-/g, " ")}
                    </text>

                    {/* Hover tooltip */}
                    {isHovered && agent.preview && (
                      <g>
                        <rect x={-80} y={-55} width={160} height={28} rx={6}
                          fill="rgba(8,8,16,0.92)" stroke={s.style.accent} strokeWidth={0.5} opacity={0.95} />
                        <text x={0} y={-40} textAnchor="middle" fill="#e0e0e0" fontSize={7}
                          fontFamily="'SF Mono', monospace">
                          {agent.preview.slice(0, 40)}
                        </text>
                        <text x={0} y={-32} textAnchor="middle" fill={s.style.accent} fontSize={6}
                          fontFamily="'SF Mono', monospace" opacity={0.6}>
                          {agent.status} · {agent.target}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* HUD overlay */}
      <div className="absolute top-4 left-6 right-6 flex items-center gap-4 px-6 py-3 rounded-2xl bg-black/50 backdrop-blur-xl border border-white/[0.06]">
        <h1 className="text-lg font-bold tracking-[6px] text-cyan-400 uppercase">
          Mission Control
        </h1>
        <span className="text-[10px] text-white/25 tracking-[3px] hidden sm:inline">
          oracle fleet overview
        </span>

        <div className="ml-auto flex items-center gap-5 text-[11px] text-white/50">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_6px_#4caf50]" : "bg-red-400 animate-pulse"}`} />
            {connected ? "LIVE" : "..."}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-orange-400" />
            <strong className="text-orange-400">{busyCount}</strong> busy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <strong className="text-emerald-400">{readyCount}</strong> ready
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-white/30" />
            <strong className="text-white/40">{idleCount}</strong> idle
          </span>
          <a href="/office/" className="text-white/25 hover:text-white/60 transition-colors">Office</a>
          <a href="/" className="text-white/25 hover:text-white/60 transition-colors">Terminal</a>
          <a href="/dashboard" className="text-white/25 hover:text-white/60 transition-colors">Orbital</a>
        </div>
      </div>

      {/* Bottom stats */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-6 px-6 py-2 rounded-xl bg-black/40 backdrop-blur border border-white/[0.04]">
        <span className="text-[10px] text-white/25 tracking-widest uppercase">Fleet Power</span>
        <div className="w-32 h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(100, (busyCount / Math.max(1, agents.length)) * 100)}%`,
              background: busyCount > 5 ? "#ef5350" : busyCount > 2 ? "#ffa726" : "#4caf50",
            }}
          />
        </div>
        <span className="text-[10px] text-white/20 tabular-nums">
          {busyCount}/{agents.length} active
        </span>
        <span className="text-[10px] text-white/15 tabular-nums">
          {sessions.length} rooms
        </span>
      </div>
    </div>
  );
});
