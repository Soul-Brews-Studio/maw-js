import { memo, useMemo, useState, useCallback, useRef } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roomStyle } from "../lib/constants";
import type { AgentState } from "../lib/types";
import type { RecentEntry } from "../lib/store";

/** 4-4-2 formation: DEF(5) → MID(5) → FWD(5) — all 15 on pitch, balanced columns
 *  GK embedded in DEF column. True 4-4-2 shape with even distribution. */
const FORMATION: Record<string, { col: number; row: number }> = {
  // DEF (col 0) — GK + back four
  "overview":      { col: 0, row: 0 },
  "odin":          { col: 0, row: 1 },
  "mother":        { col: 0, row: 2 },
  "calliope":      { col: 0, row: 3 },
  "nexus":         { col: 0, row: 4 },
  // MID (col 1) — midfield four + DMF
  "homekeeper":    { col: 1, row: 0 },
  "volt":          { col: 1, row: 1 },
  "fireman":       { col: 1, row: 2 },
  "xiaoer":        { col: 1, row: 3 },
  "dustboy":       { col: 1, row: 4 },
  // FWD (col 2) — strikers + wingers
  "pulse":         { col: 2, row: 0 },
  "neo":           { col: 2, row: 1 },
  "hermes":        { col: 2, row: 2 },
  "arthur":        { col: 2, row: 3 },
  "floodboy":      { col: 2, row: 4 },
};

const COL_LABELS = ["DEF", "MID", "FWD"];
const COL_COUNT = 3;

/** Extract oracle name from agent name (strip -oracle, -N-suffix, etc) */
function oracleName(name: string): string {
  return name.replace(/-oracle$/, "").replace(/-\d+-.*$/, "").replace(/-.*$/, "");
}

interface FootballPitchProps {
  agents: AgentState[];
  recentMap: Record<string, RecentEntry>;
  showPreview: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  hidePreview: () => void;
  onAgentClick: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  onToggleView?: () => void;
}

/** macOS Dock magnification: distance-based scaling */
const MAGNIFY_RADIUS = 120; // px — how far the effect reaches
const MAGNIFY_SCALE = 1.6;  // max scale boost on hover

export const FootballPitch = memo(function FootballPitch({
  agents,
  recentMap,
  showPreview,
  hidePreview,
  onAgentClick,
  onToggleView,
}: FootballPitchProps) {
  const pitchRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const agentRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!pitchRef.current) return;
    const rect = pitchRef.current.getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setMousePos(null);
  }, []);
  // Deduplicate: one agent per oracle (prefer main -oracle window)
  const oracleAgents = useMemo(() => {
    const byOracle = new Map<string, AgentState>();
    for (const a of agents) {
      const oracle = oracleName(a.name);
      const pos = FORMATION[oracle];
      if (!pos) continue;
      const existing = byOracle.get(oracle);
      // Prefer busy > ready > idle, then prefer -oracle suffix
      if (!existing ||
          (a.status === "busy" && existing.status !== "busy") ||
          a.name.endsWith("-oracle")) {
        byOracle.set(oracle, a);
      }
    }
    return byOracle;
  }, [agents]);

  // Group by column
  const columns = useMemo(() => {
    const cols: { oracle: string; agent: AgentState; row: number }[][] = Array.from({ length: COL_COUNT }, () => []);
    for (const [oracle, agent] of oracleAgents) {
      const pos = FORMATION[oracle];
      if (pos) cols[pos.col].push({ oracle, agent, row: pos.row });
    }
    for (const col of cols) col.sort((a, b) => a.row - b.row);
    return cols;
  }, [oracleAgents]);

  // Top 5 most recently active targets (sorted by lastBusy desc)
  const recentSorted = useMemo(() =>
    Object.entries(recentMap)
      .sort(([, a], [, b]) => b.lastBusy - a.lastBusy)
      .map(([target]) => target)
  , [recentMap]);

  return (
    <div className="mx-auto px-4 lg:px-6 pt-6 pb-2" style={{ maxWidth: "900px" }}>
      {onToggleView && (
        <div className="flex justify-end mb-2">
          <button
            onClick={onToggleView}
            className="px-3 py-1 rounded-lg text-[11px] font-mono cursor-pointer hover:opacity-80 transition-opacity"
            style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            Switch to Stage
          </button>
        </div>
      )}
      <div
        className="relative rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #0d3d0d 0%, #1a5c1a 25%, #0d3d0d 50%, #1a5c1a 75%, #0d3d0d 100%)",
          border: "2px solid rgba(255,255,255,0.15)",
          boxShadow: "0 0 40px rgba(34,139,34,0.15), inset 0 0 60px rgba(0,0,0,0.3)",
        }}
      >
        {/* Pitch markings */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 1000 500"
          preserveAspectRatio="none"
        >
          {/* Outline */}
          <rect x="20" y="20" width="960" height="460" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
          {/* Center line */}
          <line x1="500" y1="20" x2="500" y2="480" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />
          {/* Center circle */}
          <circle cx="500" cy="250" r="70" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />
          <circle cx="500" cy="250" r="3" fill="rgba(255,255,255,0.2)" />
          {/* Left penalty box */}
          <rect x="20" y="130" width="120" height="240" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
          <rect x="20" y="180" width="45" height="140" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          {/* Right penalty box */}
          <rect x="860" y="130" width="120" height="240" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
          <rect x="935" y="180" width="45" height="140" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          {/* Corner arcs */}
          <path d="M 20 35 A 15 15 0 0 1 35 20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <path d="M 965 20 A 15 15 0 0 1 980 35" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <path d="M 20 465 A 15 15 0 0 0 35 480" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <path d="M 965 480 A 15 15 0 0 0 980 465" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          {/* Grass stripes */}
          {[...Array(10)].map((_, i) => (
            <rect key={i} x={20 + i * 96} y="20" width="96" height="460" fill={i % 2 === 0 ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.02)"} />
          ))}
        </svg>

        {/* Header */}
        <div className="relative flex items-center gap-3 px-6 pt-4 pb-1 z-10">
          <span className="text-lg">⚽</span>
          <span className="text-[11px] tracking-[6px] uppercase font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>
            Formation
          </span>
          <span className="text-[12px] font-mono font-bold px-2.5 py-0.5 rounded-md" style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)" }}>
            {oracleAgents.size}
          </span>
          <div className="ml-auto flex items-center gap-3 text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
            {COL_LABELS.map((label, i) => (
              <span key={label} style={{ opacity: 0.4 + (i * 0.2) }}>{label}</span>
            ))}
          </div>
        </div>

        {/* Players grid — 3 columns with GK on goal line */}
        <div
          ref={pitchRef}
          className="relative flex justify-between px-8 py-4 z-10"
          style={{ height: 420 }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {columns.map((col, colIdx) => (
            <div
              key={colIdx}
              className="flex flex-col items-center justify-center gap-1"
              style={{ flex: 1 }}
            >
              {col.map(({ oracle, agent }) => {
                const rs = roomStyle(agent.session);
                const isBusy = agent.status === "busy";
                const isIdle = agent.status === "idle";
                const displayName = oracle.length > 8 ? oracle.slice(0, 7) + ".." : oracle;

                // Top 5 most recent get bigger (but still grey unless busy)
                const recentEntry = recentMap[agent.target];
                const recentRank = recentEntry ? recentSorted.indexOf(agent.target) : -1;
                const isTop5 = recentRank >= 0 && recentRank < 5;
                const baseSize = isBusy ? 112 : isTop5 ? 72 : 56;
                const glowSize = isBusy ? 130 : 0;

                // macOS Dock magnification
                let magnify = 1;
                const el = agentRefs.current.get(oracle);
                if (mousePos && el && pitchRef.current) {
                  const rect = el.getBoundingClientRect();
                  const pitchRect = pitchRef.current.getBoundingClientRect();
                  const cx = rect.left + rect.width / 2 - pitchRect.left;
                  const cy = rect.top + rect.height / 2 - pitchRect.top;
                  const dist = Math.sqrt((mousePos.x - cx) ** 2 + (mousePos.y - cy) ** 2);
                  if (dist < MAGNIFY_RADIUS) {
                    const t = 1 - dist / MAGNIFY_RADIUS;
                    magnify = 1 + (MAGNIFY_SCALE - 1) * Math.cos((1 - t) * Math.PI / 2);
                  }
                }
                const avatarSize = Math.round(baseSize * magnify);

                return (
                  <div
                    key={oracle}
                    ref={(node) => { if (node) agentRefs.current.set(oracle, node); }}
                    className="relative flex flex-col items-center cursor-pointer"
                    style={{
                      opacity: isBusy ? 1 : magnify > 1.05 ? 0.7 : 0.4,
                      filter: isBusy ? "none" : "grayscale(0.6)",
                      zIndex: magnify > 1.1 ? 20 : isBusy ? 10 : 1,
                      transition: mousePos ? "opacity 0.1s, filter 0.1s" : "all 0.4s ease-out",
                    }}
                    onClick={(e) => onAgentClick(agent, rs.accent, rs.label, e)}
                  >
                    {/* Super Saiyan aura for busy */}
                    {isBusy && (
                      <>
                        <div
                          className="absolute rounded-full pointer-events-none"
                          style={{
                            width: glowSize,
                            height: glowSize,
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%, -55%)",
                            background: `radial-gradient(circle, ${rs.accent}40 0%, ${rs.accent}15 40%, transparent 70%)`,
                            animation: "pulse 1.5s infinite",
                          }}
                        />
                        <div
                          className="absolute rounded-full pointer-events-none"
                          style={{
                            width: glowSize * 1.4,
                            height: glowSize * 1.4,
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%, -55%)",
                            background: `radial-gradient(circle, ${rs.accent}10 0%, transparent 60%)`,
                            animation: "pulse 2.5s infinite 0.5s",
                          }}
                        />
                      </>
                    )}
                    <svg
                      viewBox="-40 -50 80 80"
                      width={avatarSize}
                      height={avatarSize}
                      overflow="visible"
                      style={{ transition: mousePos ? "none" : "width 0.4s ease, height 0.4s ease" }}
                    >
                      <AgentAvatar
                        name={agent.name}
                        target={agent.target}
                        status={agent.status}
                        preview={agent.preview}
                        accent={rs.accent}
                        onClick={() => {}}
                      />
                    </svg>
                    <span
                      className="font-bold font-mono mt-0.5 truncate text-center"
                      style={{
                        fontSize: isBusy ? 12 : 10,
                        color: rs.accent,
                        maxWidth: isBusy ? 90 : 64,
                        textShadow: isBusy ? `0 0 12px ${rs.accent}80` : "none",
                        transition: "all 0.5s ease",
                      }}
                    >
                      {displayName}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

      </div>
    </div>
  );
});
