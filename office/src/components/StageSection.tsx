import { memo, useMemo } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roomStyle } from "../lib/constants";
import type { RecentEntry } from "../lib/store";
import type { AgentState } from "../lib/types";
import type { FeedLogEntry } from "./FleetGrid";

interface StageSectionProps {
  busyAgents: AgentState[];
  recentlyActive: (AgentState | RecentEntry)[];
  recentMap: Record<string, RecentEntry>;
  getAgentFeedLog?: (name: string) => FeedLogEntry[] | null;
  showPreview: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  hidePreview: () => void;
  onAgentClick: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
}

/** Ghost shrinks from 2x → 1x over SHRINK_MS after going inactive */
const SHRINK_MS = 60_000; // 60s to fully shrink
const SIZE_BIG = 112;
const SIZE_SMALL = 56;

function ghostSize(lastBusy: number): number {
  const elapsed = Date.now() - lastBusy;
  if (elapsed <= 0) return SIZE_BIG;
  if (elapsed >= SHRINK_MS) return SIZE_SMALL;
  // Linear interpolation: big → small
  const t = elapsed / SHRINK_MS;
  return Math.round(SIZE_BIG - (SIZE_BIG - SIZE_SMALL) * t);
}

export const StageSection = memo(function StageSection({
  busyAgents,
  recentlyActive,
  recentMap,
  getAgentFeedLog,
  showPreview,
  hidePreview,
  onAgentClick,
}: StageSectionProps) {
  // Active performers: busy agents
  const activeAgents = useMemo(() => {
    const seenNames = new Set<string>();
    const result: AgentState[] = [];
    for (const a of busyAgents) {
      if (!seenNames.has(a.name)) { seenNames.add(a.name); result.push(a); }
    }
    // Sort by most recently active first (leftmost)
    result.sort((a, b) => (recentMap[b.target]?.lastBusy || 0) - (recentMap[a.target]?.lastBusy || 0));
    return result;
  }, [busyAgents, recentMap]);

  // Ghost agents: recent but not active, shown greyed out on stage (dedup by name)
  const ghostAgents = useMemo(() => {
    const activeNames = new Set(activeAgents.map(a => a.name));
    const seenNames = new Set<string>();
    return recentlyActive
      .filter(e => !activeNames.has(e.name))
      .filter(e => {
        if (seenNames.has(e.name)) return false;
        seenNames.add(e.name);
        return true;
      })
      .slice(0, 5)
      .map(e => {
        if ("status" in e) return e as AgentState;
        return { target: e.target, name: e.name, session: e.session, windowIndex: 0, active: false, preview: "", status: "idle" as const };
      });
  }, [activeAgents, recentlyActive]);

  if (activeAgents.length === 0 && ghostAgents.length === 0) return null;

  const hasBusy = activeAgents.length > 0;

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-8 pt-6 pb-2">
      <div
        className="relative rounded-2xl overflow-hidden"
        style={{
          background: hasBusy
            ? "linear-gradient(180deg, #1a1510 0%, #0f0d0a 60%, #0a0a12 100%)"
            : "linear-gradient(180deg, #121218 0%, #0e0e14 60%, #0a0a12 100%)",
          border: hasBusy ? "1px solid rgba(251,191,36,0.15)" : "1px solid rgba(255,255,255,0.06)",
          boxShadow: hasBusy
            ? "0 0 40px rgba(251,191,36,0.06), inset 0 -2px 20px rgba(0,0,0,0.4)"
            : "0 2px 12px rgba(0,0,0,0.3)",
        }}
      >
        {/* Stage lights — top glow */}
        <div
          className="absolute top-0 left-0 right-0 h-24 pointer-events-none"
          style={{
            background: hasBusy
              ? "radial-gradient(ellipse 80% 100% at 50% 0%, rgba(251,191,36,0.08) 0%, transparent 70%)"
              : "radial-gradient(ellipse 80% 100% at 50% 0%, rgba(255,255,255,0.02) 0%, transparent 70%)",
          }}
        />

        {/* Spotlight cones */}
        {hasBusy && (
          <>
            <div className="absolute top-0 left-[20%] w-px h-16 pointer-events-none" style={{ background: "linear-gradient(180deg, rgba(251,191,36,0.15), transparent)" }} />
            <div className="absolute top-0 left-[50%] w-px h-20 pointer-events-none" style={{ background: "linear-gradient(180deg, rgba(251,191,36,0.2), transparent)" }} />
            <div className="absolute top-0 left-[80%] w-px h-16 pointer-events-none" style={{ background: "linear-gradient(180deg, rgba(251,191,36,0.15), transparent)" }} />
          </>
        )}

        {/* Header */}
        <div className="relative flex items-center gap-3 px-6 pt-4 pb-2">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{
              background: hasBusy ? "#fbbf24" : "#64748B",
              boxShadow: hasBusy ? "0 0 10px #ffa726" : "none",
              animation: hasBusy ? "pulse 2s infinite" : "none",
            }}
          />
          <span className="text-[11px] tracking-[6px] uppercase font-mono" style={{ color: hasBusy ? "rgba(251,191,36,0.7)" : "rgba(255,255,255,0.25)" }}>
            On Stage
          </span>
          <span
            className="text-[12px] font-mono font-bold px-2.5 py-0.5 rounded-md"
            style={{
              background: hasBusy ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.05)",
              color: hasBusy ? "#fbbf24" : "#64748B",
            }}
          >
            {activeAgents.length}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: hasBusy ? "#fbbf24" : "#64748B",
                  opacity: hasBusy ? 0.2 + (i % 2) * 0.15 : 0.1 + (i % 2) * 0.05,
                  boxShadow: hasBusy ? "0 0 3px rgba(251,191,36,0.3)" : "none",
                }}
              />
            ))}
          </div>
        </div>

        {/* Stage floor */}
        <div className="relative flex flex-wrap gap-4 justify-center px-6 pt-2 pb-5">
          <div
            className="absolute bottom-0 left-6 right-6 h-px"
            style={{
              background: hasBusy
                ? "linear-gradient(90deg, transparent 0%, rgba(251,191,36,0.12) 30%, rgba(251,191,36,0.12) 70%, transparent 100%)"
                : "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.04) 70%, transparent 100%)",
            }}
          />

          {/* Active performers — 2x size */}
          {activeAgents.map((agent) => {
            const rs = roomStyle(agent.session);
            const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
            const feedLog = getAgentFeedLog?.(agent.name);
            return (
              <div
                key={`stage-${agent.target}`}
                className="relative flex flex-col items-center gap-2 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 hover:scale-110 hover:-translate-y-1"
                style={{ minWidth: 120 }}
                onMouseEnter={(e) => showPreview(agent, rs.accent, rs.label, e)}
                onMouseLeave={() => hidePreview()}
                onClick={(e) => onAgentClick(agent, rs.accent, rs.label, e)}
              >
                <div
                  className="absolute -top-2 left-1/2 -translate-x-1/2 w-24 h-28 pointer-events-none"
                  style={{ background: `radial-gradient(ellipse at 50% 0%, ${rs.accent}15 0%, transparent 70%)` }}
                />
                <svg viewBox="-40 -50 80 80" width={112} height={112} overflow="visible">
                  <AgentAvatar
                    name={agent.name}
                    target={agent.target}
                    status={agent.status}
                    preview={agent.preview}
                    accent={rs.accent}
                    activity={feedLog?.[0]?.text}
                    onClick={() => {}}
                  />
                </svg>
                <span className="text-[12px] font-semibold truncate max-w-[120px] text-center" style={{ color: rs.accent }}>
                  {displayName}
                </span>
              </div>
            );
          })}

          {/* Ghost agents — start big, shrink over 60s */}
          {ghostAgents.map((agent) => {
            const rs = roomStyle(agent.session);
            const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
            const lastBusy = recentMap[agent.target]?.lastBusy || 0;
            const size = ghostSize(lastBusy);
            const t = Math.min(1, (Date.now() - lastBusy) / SHRINK_MS); // 0=just left, 1=fully shrunk
            const opacity = 0.6 - t * 0.3; // 0.6 → 0.3
            const grayscale = 0.3 + t * 0.4; // 0.3 → 0.7
            return (
              <div
                key={`ghost-${agent.target}`}
                className="relative flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl cursor-pointer hover:scale-105 hover:opacity-60"
                style={{ minWidth: size > 80 ? 120 : 76, opacity, filter: `grayscale(${grayscale})`, transition: "all 2s ease-out" }}
                onMouseEnter={(e) => showPreview(agent, rs.accent, rs.label, e)}
                onMouseLeave={() => hidePreview()}
                onClick={(e) => onAgentClick(agent, rs.accent, rs.label, e)}
              >
                <svg viewBox="-40 -50 80 80" width={size} height={size} overflow="visible" style={{ transition: "width 2s ease-out, height 2s ease-out" }}>
                  <AgentAvatar
                    name={agent.name}
                    target={agent.target}
                    status={agent.status}
                    preview={agent.preview}
                    accent={rs.accent}
                    onClick={() => {}}
                  />
                </svg>
                <span className="font-semibold truncate text-center" style={{ color: "#64748B", fontSize: size > 80 ? 12 : 10, maxWidth: size > 80 ? 120 : 76, transition: "all 2s ease-out" }}>
                  {displayName}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footlights */}
        <div
          className="h-1 rounded-b-2xl"
          style={{
            background: hasBusy
              ? "linear-gradient(90deg, transparent 5%, rgba(251,191,36,0.2) 20%, rgba(251,191,36,0.3) 50%, rgba(251,191,36,0.2) 80%, transparent 95%)"
              : "linear-gradient(90deg, transparent 5%, rgba(255,255,255,0.04) 20%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.04) 80%, transparent 95%)",
          }}
        />
      </div>
    </div>
  );
});
