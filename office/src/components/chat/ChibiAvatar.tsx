import { agentColor } from "../../lib/constants";
import { nameHash, isHuman } from "./types";

export function ChibiAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const color = agentColor(name);
  const h = nameHash(name);
  const hasEars = h % 3 === 0;
  const hasAntenna = !hasEars && h % 3 === 1;
  const eyeStyle = (h >> 4) % 3;

  if (isHuman(name)) {
    return (
      <svg width={size} height={size} viewBox="-25 -35 50 50" className="flex-shrink-0">
        <circle cx={0} cy={-10} r={20} fill="#e8b86d" stroke="#fff" strokeWidth={1.5} />
        <ellipse cx={0} cy={-24} rx={16} ry={8} fill="#2c1b0e" />
        <ellipse cx={-8} cy={-22} rx={6} ry={5} fill="#2c1b0e" />
        <ellipse cx={8} cy={-22} rx={6} ry={5} fill="#2c1b0e" />
        <circle cx={-7} cy={-12} r={3.5} fill="#fff" />
        <circle cx={7} cy={-12} r={3.5} fill="#fff" />
        <circle cx={-6} cy={-12} r={2} fill="#1a1a1a" />
        <circle cx={8} cy={-12} r={2} fill="#1a1a1a" />
        <circle cx={-5} cy={-13} r={0.8} fill="#fff" />
        <circle cx={9} cy={-13} r={0.8} fill="#fff" />
        <path d="M -4 -4 Q 0 -1 4 -4" fill="none" stroke="#333" strokeWidth={1.2} strokeLinecap="round" />
        <circle cx={-7} cy={-12} r={6} fill="none" stroke="#555" strokeWidth={1.2} />
        <circle cx={7} cy={-12} r={6} fill="none" stroke="#555" strokeWidth={1.2} />
        <line x1={-1} y1={-12} x2={1} y2={-12} stroke="#555" strokeWidth={1} />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="-25 -35 50 50" className="flex-shrink-0">
      <circle cx={0} cy={-10} r={20} fill={color} stroke="#fff" strokeWidth={1.5} />
      <ellipse cx={-4} cy={-28} rx={6} ry={4} fill={color} stroke="#fff" strokeWidth={0.8} />
      <ellipse cx={4} cy={-29} rx={5} ry={3} fill={color} stroke="#fff" strokeWidth={0.8} />
      {hasEars && (
        <>
          <polygon points="-14,-24 -18,-36 -6,-28" fill={color} stroke="#fff" strokeWidth={1.2} />
          <polygon points="14,-24 18,-36 6,-28" fill={color} stroke="#fff" strokeWidth={1.2} />
          <polygon points="-13,-25 -16,-33 -8,-27" fill="#ffb4b4" opacity={0.4} />
          <polygon points="13,-25 16,-33 8,-27" fill="#ffb4b4" opacity={0.4} />
        </>
      )}
      {hasAntenna && (
        <>
          <line x1={0} y1={-30} x2={0} y2={-40} stroke="#888" strokeWidth={1.5} />
          <circle cx={0} cy={-42} r={3} fill={color} opacity={0.8} />
        </>
      )}
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
      <ellipse cx={-12} cy={-7} rx={3} ry={2} fill="#ff9999" opacity={0.25} />
      <ellipse cx={12} cy={-7} rx={3} ry={2} fill="#ff9999" opacity={0.25} />
      <path d="M -3 -5 Q 0 -2 3 -5" fill="none" stroke="#333" strokeWidth={1.2} strokeLinecap="round" />
      <path d="M -17 -14 Q -18 -28 0 -30 Q 18 -28 17 -14" fill="none" stroke="#555" strokeWidth={2} />
      <rect x={-20} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={0.8} />
      <rect x={14} y={-18} width={6} height={10} rx={3} fill="#444" stroke="#555" strokeWidth={0.8} />
    </svg>
  );
}
