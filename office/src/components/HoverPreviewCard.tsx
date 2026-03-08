import { useState, useEffect, useRef, memo } from "react";
import { ansiToHtml } from "../lib/ansi";
import { agentColor } from "../lib/constants";
import type { AgentState } from "../lib/types";

interface HoverPreviewCardProps {
  agent: AgentState;
  roomLabel: string;
  accent: string;
}

const STATUS_COLORS: Record<string, string> = {
  busy: "#fdd835",
  ready: "#4caf50",
  idle: "#666",
};

const STATUS_LABELS: Record<string, string> = {
  busy: "BUSY",
  ready: "READY",
  idle: "IDLE",
};

function trimCapture(raw: string): string {
  const lines = raw.split("\n");
  while (lines.length > 0) {
    const stripped = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (stripped === "") lines.pop();
    else break;
  }
  return lines.join("\n");
}

export const HoverPreviewCard = memo(function HoverPreviewCard({
  agent,
  roomLabel,
  accent,
}: HoverPreviewCardProps) {
  const [content, setContent] = useState("");
  const termRef = useRef<HTMLDivElement>(null);
  const color = agentColor(agent.name);
  const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
  const statusColor = STATUS_COLORS[agent.status] || "#666";

  // Poll terminal capture
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetch(`/api/capture?target=${encodeURIComponent(agent.target)}`);
        const data = await res.json();
        if (active) setContent(data.content || "");
      } catch {}
      if (active) setTimeout(poll, 500);
    }
    poll();
    return () => { active = false; };
  }, [agent.target]);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [content]);

  // Deterministic chibi features (same logic as AgentAvatar)
  let h = 0;
  for (let i = 0; i < agent.name.length; i++) h = ((h << 5) - h + agent.name.charCodeAt(i)) | 0;
  const hasEars = Math.abs(h) % 3 === 0;
  const hasAntenna = !hasEars && Math.abs(h) % 3 === 1;
  const eyeStyle = Math.abs(h >> 4) % 3;

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-white/[0.08] shadow-2xl"
      style={{
        background: "#0a0a0f",
        width: 420,
        height: "calc(100vh - 120px)",
        maxHeight: 700,
      }}
    >
      {/* Header with big avatar */}
      <div
        className="relative flex flex-col items-center pt-6 pb-4 px-4"
        style={{
          background: `linear-gradient(180deg, ${accent}15 0%, transparent 100%)`,
          borderBottom: `1px solid ${accent}20`,
        }}
      >
        {/* Big chibi SVG avatar */}
        <svg width={100} height={90} viewBox="-40 -45 80 80">
          {/* Aura */}
          {agent.status === "busy" && (
            <>
              <circle cx={0} cy={-6} r={36} fill={statusColor} opacity={0.08}
                style={{ animation: "saiyan-aura 2s ease-in-out infinite" }} />
              <circle cx={0} cy={-6} r={42} fill="none" stroke={statusColor} strokeWidth={2}
                opacity={0.15} style={{ animation: "saiyan-outer 2s ease-in-out infinite" }} />
            </>
          )}
          {agent.status === "ready" && (
            <circle cx={0} cy={-6} r={28} fill={statusColor} opacity={0.08} />
          )}

          {/* Ground shadow */}
          <ellipse cx={0} cy={24} rx={16} ry={4}
            fill={agent.status === "idle" ? "#333" : statusColor}
            opacity={agent.status === "idle" ? 0.3 : 0.2} />

          {/* Body */}
          <rect x={-12} y={6} width={24} height={18} rx={8}
            fill={color} stroke="#fff" strokeWidth={1.5} opacity={0.9} />
          <rect x={-6} y={14} width={12} height={5} rx={2} fill="#000" opacity={0.12} />

          {/* Head */}
          <circle cx={0} cy={-10} r={20} fill={color} stroke="#fff" strokeWidth={2} />

          {/* Hair */}
          <ellipse cx={-4} cy={-28} rx={6} ry={4} fill={color} stroke="#fff" strokeWidth={1} />
          <ellipse cx={4} cy={-29} rx={5} ry={3} fill={color} stroke="#fff" strokeWidth={1} />

          {/* Cat ears */}
          {hasEars && (
            <>
              <polygon points="-14,-24 -18,-36 -6,-28" fill={color} stroke="#fff" strokeWidth={1.5} />
              <polygon points="14,-24 18,-36 6,-28" fill={color} stroke="#fff" strokeWidth={1.5} />
              <polygon points="-13,-25 -16,-33 -8,-27" fill="#ffb4b4" opacity={0.4} />
              <polygon points="13,-25 16,-33 8,-27" fill="#ffb4b4" opacity={0.4} />
            </>
          )}

          {/* Antenna */}
          {hasAntenna && (
            <>
              <line x1={0} y1={-30} x2={0} y2={-40} stroke="#888" strokeWidth={1.5} />
              <circle cx={0} cy={-42} r={3} fill={statusColor} />
            </>
          )}

          {/* Eyes */}
          {eyeStyle === 0 && (
            <>
              <circle cx={-7} cy={-12} r={4.5} fill="#fff" />
              <circle cx={7} cy={-12} r={4.5} fill="#fff" />
              <circle cx={-6} cy={-12} r={2.5} fill="#222" />
              <circle cx={8} cy={-12} r={2.5} fill="#222" />
              <circle cx={-5} cy={-13.5} r={1} fill="#fff" />
              <circle cx={9} cy={-13.5} r={1} fill="#fff" />
            </>
          )}
          {eyeStyle === 1 && (
            <>
              <path d="M -10 -12 Q -7 -15 -4 -12" fill="none" stroke="#222" strokeWidth={1.8} strokeLinecap="round" />
              <path d="M 4 -12 Q 7 -15 10 -12" fill="none" stroke="#222" strokeWidth={1.8} strokeLinecap="round" />
            </>
          )}
          {eyeStyle === 2 && (
            <>
              <circle cx={-7} cy={-12} r={4.5} fill="#fff" />
              <circle cx={7} cy={-12} r={4.5} fill="#fff" />
              <text x={-7} y={-9.5} textAnchor="middle" fill={color} fontSize={7} fontWeight="bold">*</text>
              <text x={7} y={-9.5} textAnchor="middle" fill={color} fontSize={7} fontWeight="bold">*</text>
            </>
          )}

          {/* Blush */}
          <ellipse cx={-12} cy={-7} rx={3} ry={2} fill="#ff9999" opacity={0.25} />
          <ellipse cx={12} cy={-7} rx={3} ry={2} fill="#ff9999" opacity={0.25} />

          {/* Mouth */}
          {agent.status === "busy" ? (
            <ellipse cx={0} cy={-4} rx={2.5} ry={2} fill="#333" />
          ) : (
            <path d="M -3 -5 Q 0 -2 3 -5" fill="none" stroke="#333" strokeWidth={1.2} strokeLinecap="round" />
          )}

          {/* Headphones */}
          <path d="M -17 -14 Q -18 -28 0 -30 Q 18 -28 17 -14" fill="none" stroke="#555" strokeWidth={2.5} />
          <rect x={-20} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={1} />
          <rect x={14} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={1} />
          <line x1={-19} y1={-10} x2={-14} y2={-2} stroke="#555" strokeWidth={1.2} />
          <circle cx={-13} cy={-1} r={1.5} fill="#666" />

          {/* Arms */}
          {agent.status === "busy" ? (
            <>
              <g style={{ animation: "typing-arm 0.25s ease-in-out infinite" }}>
                <line x1={-12} y1={10} x2={-22} y2={18} stroke={color} strokeWidth={3} strokeLinecap="round" />
              </g>
              <g style={{ animation: "typing-arm 0.25s ease-in-out 0.12s infinite" }}>
                <line x1={12} y1={10} x2={22} y2={18} stroke={color} strokeWidth={3} strokeLinecap="round" />
              </g>
            </>
          ) : (
            <>
              <line x1={-12} y1={10} x2={-16} y2={20} stroke={color} strokeWidth={3} strokeLinecap="round" />
              <line x1={12} y1={10} x2={16} y2={20} stroke={color} strokeWidth={3} strokeLinecap="round" />
            </>
          )}

          {/* Legs + shoes */}
          <line x1={-5} y1={23} x2={-6} y2={28} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
          <line x1={5} y1={23} x2={6} y2={28} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
          <ellipse cx={-7} cy={29} rx={3.5} ry={2} fill="#333" />
          <ellipse cx={7} cy={29} rx={3.5} ry={2} fill="#333" />
        </svg>

        {/* Name + status */}
        <h2
          className="mt-2 text-base font-bold tracking-[3px] uppercase"
          style={{ color: accent }}
        >
          {displayName}
        </h2>

        <div className="flex items-center gap-3 mt-1.5">
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: statusColor,
                boxShadow: agent.status !== "idle" ? `0 0 6px ${statusColor}` : undefined,
              }}
            />
            <span className="text-[10px] font-mono" style={{ color: statusColor }}>
              {STATUS_LABELS[agent.status]}
            </span>
          </span>
          <span className="text-[10px] text-white/40 font-mono">{roomLabel}</span>
        </div>

        <span className="mt-1 text-[9px] text-white/25 font-mono">{agent.target}</span>
      </div>

      {/* Terminal preview */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.04]">
        <span className="text-[9px] text-white/30 tracking-[2px] uppercase font-mono">Live Terminal</span>
        <span
          className="w-1.5 h-1.5 rounded-full ml-auto"
          style={{
            background: "#4caf50",
            boxShadow: "0 0 4px #4caf50",
            animation: "agent-pulse 2s ease-in-out infinite",
          }}
        />
      </div>

      <div
        ref={termRef}
        className="flex-1 px-3 py-2 overflow-y-auto font-mono text-[10px] leading-[1.4] text-[#cdd6f4] whitespace-pre-wrap break-all"
        style={{ background: "#08080c" }}
        dangerouslySetInnerHTML={{ __html: ansiToHtml(trimCapture(content)) }}
      />

      {/* Bottom bar with preview line */}
      <div className="px-3 py-2 bg-[#0e0e18] border-t border-white/[0.06] font-mono text-[9px] text-white/30 truncate">
        {agent.preview || "..."}
      </div>
    </div>
  );
});
