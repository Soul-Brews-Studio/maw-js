import { memo, useMemo } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roomStyle } from "../lib/constants";
import type { AgentState } from "../lib/types";
import type { RecentEntry } from "../lib/store";

/** Map oracle name → formation position. Left-to-right: GK → DEF → MID → FWD (1-4-5-5) */
const FORMATION: Record<string, { col: number; row: number }> = {
  // GK (col 0) — overview
  "overview":      { col: 0, row: 2 },
  // DEF (col 1) — knowledge layer (4)
  "odin":          { col: 1, row: 0 },
  "mother":        { col: 1, row: 1 },
  "nexus":         { col: 1, row: 2 },
  "calliope":      { col: 1, row: 3 },
  // MID (col 2) — infra + project layer (5)
  "homekeeper":    { col: 2, row: 0 },
  "volt":          { col: 2, row: 1 },
  "fireman":       { col: 2, row: 2 },
  "xiaoer":        { col: 2, row: 3 },
  "dustboy":       { col: 2, row: 4 },
  // FWD (col 3) — command + attack layer (5)
  "pulse":         { col: 3, row: 0 },
  "hermes":        { col: 3, row: 1 },
  "neo":           { col: 3, row: 2 },
  "arthur":        { col: 3, row: 3 },
  "floodboy":      { col: 3, row: 4 },
  // Subs — not on pitch (dustboychain mapped to bench)
};

const COL_LABELS = ["GK", "DEF", "MID", "FWD"];
const COL_COUNT = 4;

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
}

export const FootballPitch = memo(function FootballPitch({
  agents,
  recentMap,
  showPreview,
  hidePreview,
  onAgentClick,
}: FootballPitchProps) {
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

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-8 pt-6 pb-2">
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

        {/* Players grid — 4 columns left to right */}
        <div className="relative flex justify-between px-8 py-4 z-10" style={{ minHeight: 280 }}>
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

                const avatarSize = isBusy ? 88 : 56;
                const glowSize = isBusy ? 100 : 0;

                return (
                  <div
                    key={oracle}
                    className="relative flex flex-col items-center cursor-pointer transition-all duration-500"
                    style={{
                      opacity: isIdle ? 0.35 : isBusy ? 1 : 0.6,
                      filter: isIdle ? "grayscale(0.7)" : "none",
                      zIndex: isBusy ? 10 : 1,
                    }}
                    onMouseEnter={(e) => showPreview(agent, rs.accent, rs.label, e)}
                    onMouseLeave={() => hidePreview()}
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
                      style={{ transition: "width 0.5s ease, height 0.5s ease" }}
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
                        fontSize: isBusy ? 11 : 9,
                        color: isBusy ? rs.accent : isIdle ? "#555" : "#888",
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
