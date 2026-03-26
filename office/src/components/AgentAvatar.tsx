import { memo } from "react";
import { agentColor, agentIcon } from "../lib/constants";
import type { PaneStatus } from "../lib/types";

const STATUS_FX: Record<PaneStatus, { color: string; aura: number; sparkle: boolean; typing: boolean }> = {
  ready: { color: "#4caf50", aura: 1, sparkle: false, typing: false },
  busy:  { color: "#fdd835", aura: 2, sparkle: true, typing: true },
  idle:  { color: "#666",    aura: 0, sparkle: false, typing: false },
};

interface AgentAvatarProps {
  name: string;
  target: string;
  status: PaneStatus;
  preview: string;
  accent: string;
  activity?: string;
  onClick: () => void;
}

export const AgentAvatar = memo(function AgentAvatar({ name, target, status, preview, accent, activity, onClick }: AgentAvatarProps) {
  const color = agentColor(name);
  const fx = STATUS_FX[status];
  const filterId = `glow-${target.replace(/[^a-z0-9]/gi, "-")}`;
  const auraId = `aura-${target.replace(/[^a-z0-9]/gi, "-")}`;

  const displayName = name.replace(/-oracle$/, "").replace(/-/g, " ");
  const shortName = displayName.length > 10 ? displayName.slice(0, 10) + ".." : displayName;
  const icon = agentIcon(name);
  const isCompacting = preview.toLowerCase().includes("compacting");

  // Deterministic features from name hash
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const hasEars = Math.abs(h) % 3 === 0; // cat ears
  const hasAntenna = !hasEars && Math.abs(h) % 3 === 1; // antenna
  const eyeStyle = Math.abs(h >> 4) % 3; // 0=round, 1=happy, 2=star

  return (
    <g
      style={{ cursor: "pointer" }}
      onClick={onClick}
    >
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
        </filter>
        <radialGradient id={auraId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={fx.color} stopOpacity={0.3} />
          <stop offset="70%" stopColor={fx.color} stopOpacity={0.05} />
          <stop offset="100%" stopColor={fx.color} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* === LEVEL 2 AURA (busy) === */}
      {fx.aura >= 2 && (
        <>
          <circle cx={0} cy={-6} r={42} fill="none" stroke={fx.color} strokeWidth={2}
            opacity={0.2} style={{ animation: "saiyan-outer 2s ease-in-out infinite" }} />
          <circle cx={0} cy={-6} r={36} fill={`url(#${auraId})`}
            style={{ animation: "saiyan-aura 2s ease-in-out infinite" }} />
          <rect x={-1.5} y={-65} width={3} height={30} rx={1} fill={fx.color} opacity={0.25}
            style={{ animation: "agent-pulse 0.6s ease-in-out infinite" }} />
          <ellipse cx={0} cy={24} rx={24} ry={6} fill="none" stroke={fx.color} strokeWidth={2}
            opacity={0.35} style={{ animation: "agent-pulse 0.8s ease-in-out infinite" }} />
        </>
      )}

      {/* === LEVEL 1 AURA (ready — subtle glow) === */}
      {fx.aura === 1 && (
        <>
          <circle cx={0} cy={-6} r={28} fill={`url(#${auraId})`} />
          <ellipse cx={0} cy={24} rx={18} ry={4} fill={fx.color} opacity={0.15} />
        </>
      )}

      {/* === SPARKLES (busy) === */}
      {fx.sparkle && (
        <>
          {[
            { ox: -24, oy: -28, d: 0 }, { ox: 22, oy: -16, d: 0.4 },
            { ox: -18, oy: 5, d: 0.8 }, { ox: 26, oy: -32, d: 1.2 },
          ].map((s, i) => (
            <g key={i} transform={`translate(${s.ox}, ${s.oy})`}
              style={{ animation: `sparkle 1.2s ease-in-out ${s.d}s infinite` }}>
              <line x1={-3} y1={0} x2={3} y2={0} stroke={fx.color} strokeWidth={1.5} />
              <line x1={0} y1={-3} x2={0} y2={3} stroke={fx.color} strokeWidth={1.5} />
            </g>
          ))}
        </>
      )}

      {/* Ground shadow */}
      <ellipse cx={0} cy={24} rx={16} ry={4}
        fill={status === "idle" ? "#333" : fx.color}
        opacity={status === "idle" ? 0.3 : 0.2} />

      {/* Chibi body group — spins when busy or compacting */}
      <g style={(fx.typing || isCompacting) ? { animation: "chibi-spin 3s ease-in-out infinite", transformOrigin: "0 0" } : {}}>

      {/* === CHIBI BODY (small hoodie) === */}
      <rect x={-12} y={6} width={24} height={18} rx={8}
        fill={color} stroke="#fff" strokeWidth={1.5} opacity={0.9} />
      {/* Hoodie pocket */}
      <rect x={-6} y={14} width={12} height={5} rx={2} fill="#000" opacity={0.12} />
      {/* Oracle icon badge on hoodie */}
      {icon && (
        <text x={0} y={13} textAnchor="middle" fontSize={8} style={{ pointerEvents: "none" }}>
          {icon}
        </text>
      )}

      {/* === HEAD (big round) === */}
      <circle cx={0} cy={-10} r={20} fill={color} stroke="#fff" strokeWidth={2} />

      {/* Head energy overlay (busy) */}
      {fx.aura >= 2 && (
        <circle cx={0} cy={-10} r={20} fill={fx.color} opacity={0.15}
          style={{ animation: "agent-pulse 1s ease-in-out infinite" }} />
      )}

      {/* Hair tuft */}
      <ellipse cx={-4} cy={-28} rx={6} ry={4} fill={color}
        stroke="#fff" strokeWidth={1} />
      <ellipse cx={4} cy={-29} rx={5} ry={3} fill={color}
        stroke="#fff" strokeWidth={1} />

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
          <circle cx={0} cy={-42} r={3} fill={fx.color}
            style={fx.aura >= 2 ? { animation: "agent-pulse 0.5s ease-in-out infinite" } : {}} />
        </>
      )}

      {/* === EYES === */}
      {eyeStyle === 0 && (
        <>
          {/* Round sparkly eyes */}
          <circle cx={-7} cy={-12} r={4.5} fill="#fff" />
          <circle cx={7} cy={-12} r={4.5} fill="#fff" />
          <circle cx={-6} cy={-12} r={2.5} fill="#222" />
          <circle cx={8} cy={-12} r={2.5} fill="#222" />
          {/* Sparkle */}
          <circle cx={-5} cy={-13.5} r={1} fill="#fff" />
          <circle cx={9} cy={-13.5} r={1} fill="#fff" />
        </>
      )}
      {eyeStyle === 1 && (
        <>
          {/* Happy closed eyes ^_^ */}
          <path d="M -10 -12 Q -7 -15 -4 -12" fill="none" stroke="#222" strokeWidth={1.8} strokeLinecap="round" />
          <path d="M 4 -12 Q 7 -15 10 -12" fill="none" stroke="#222" strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {eyeStyle === 2 && (
        <>
          {/* Star eyes */}
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
      {status === "busy" ? (
        <ellipse cx={0} cy={-4} rx={2.5} ry={2} fill="#333" />
      ) : (
        <path d="M -3 -5 Q 0 -2 3 -5" fill="none" stroke="#333" strokeWidth={1.2} strokeLinecap="round" />
      )}

      {/* === HEADPHONES === */}
      <path d="M -17 -14 Q -18 -28 0 -30 Q 18 -28 17 -14" fill="none" stroke="#555" strokeWidth={2.5} />
      <rect x={-20} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={1} />
      <rect x={14} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={1} />

      {/* Mic boom */}
      <line x1={-19} y1={-10} x2={-14} y2={-2} stroke="#555" strokeWidth={1.2} />
      <circle cx={-13} cy={-1} r={1.5} fill="#666" />

      {/* === ARMS === */}
      {fx.typing ? (
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

      {/* === LEGS === */}
      <line x1={-5} y1={23} x2={-6} y2={28} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      <line x1={5} y1={23} x2={6} y2={28} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      {/* Tiny shoes */}
      <ellipse cx={-7} cy={29} rx={3.5} ry={2} fill="#333" />
      <ellipse cx={7} cy={29} rx={3.5} ry={2} fill="#333" />

      </g>{/* end chibi-spin group */}

      {/* Status dot */}
      {status !== "idle" && (
        <circle cx={16} cy={-28} r={5} fill={fx.color} opacity={0.4} filter={`url(#${filterId})`} />
      )}
      <circle cx={16} cy={-28} r={3.5} fill={fx.color} stroke="#1a1a1a" strokeWidth={1.5}
        style={fx.aura >= 2 ? { animation: "agent-pulse 0.6s ease-in-out infinite" } : {}} />

      {/* Name label removed — rendered as HTML in AgentCard */}

      {/* Name speech bubble above head (cartoon style) */}
      {(() => {
        const featureTop = hasAntenna ? -45 : hasEars ? -36 : -32;
        const bubbleGap = 2;
        const bubbleH = 11;
        const bubbleY = featureTop - bubbleGap - bubbleH;
        const tailY = featureTop - bubbleGap;
        const bubbleW = Math.min(90, (icon ? shortName.length + 2 : shortName.length) * 6 + 16);
        return (
          <g style={{ pointerEvents: "none" }}>
            <rect x={-bubbleW / 2} y={bubbleY} width={bubbleW} height={bubbleH}
              rx={4} ry={4} fill="rgba(0,0,0,0.65)" stroke={accent} strokeWidth={0.5} strokeOpacity={0.3} />
            <polygon
              points={`-3,${tailY} 3,${tailY} 0,${tailY + 4}`}
              fill="rgba(0,0,0,0.65)" stroke={accent} strokeWidth={0.5} strokeOpacity={0.3}
            />
            <rect x={-4} y={tailY - 1} width={8} height={2} fill="rgba(0,0,0,0.65)" />
            <text x={0} y={bubbleY + bubbleH / 2 + 2.5} textAnchor="middle"
              fill={accent} fontSize={7} fontFamily="'SF Mono', monospace" opacity={0.9}>
              {icon ? `${icon} ${shortName}` : shortName}
            </text>
          </g>
        );
      })()}
      {/* Floating code (busy, no activity) */}
      {fx.typing && preview && !activity && (
        <foreignObject x={-65} y={-70} width={130} height={20} style={{ pointerEvents: "none" }}>
          <div style={{
            animation: "float-code 3s ease-in-out infinite",
            fontSize: "7px", color: accent, fontFamily: "'Courier New', monospace",
            textAlign: "center", whiteSpace: "nowrap", overflow: "hidden",
            textOverflow: "ellipsis", opacity: 0.7,
            textShadow: `0 0 4px ${accent}`,
          }}>{preview.slice(0, 45)}</div>
        </foreignObject>
      )}

      {/* Tooltip rendered as HTML in AgentCard */}
    </g>
  );
});
