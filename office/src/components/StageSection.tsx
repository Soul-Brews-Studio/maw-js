import { memo, useMemo } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { roomStyle } from "../lib/constants";
import type { RecentEntry } from "../lib/store";
import type { AgentState } from "../lib/types";

interface StageSectionProps {
  busyAgents: AgentState[];
  recentlyActive: (AgentState | RecentEntry)[];
  saiyanTargets: Set<string>;
  showPreview: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
  hidePreview: () => void;
  onAgentClick: (agent: AgentState, accent: string, label: string, e: React.MouseEvent) => void;
}

export const StageSection = memo(function StageSection({
  busyAgents,
  recentlyActive,
  saiyanTargets,
  showPreview,
  hidePreview,
  onAgentClick,
}: StageSectionProps) {
  // Ghost agents: recent but not busy, shown greyed out on stage (dedup by name)
  const ghostAgents = useMemo(() => {
    const busyNames = new Set(busyAgents.map(a => a.name));
    const seenNames = new Set<string>();
    return recentlyActive
      .filter(e => !busyNames.has(e.name))
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
  }, [busyAgents, recentlyActive]);

  if (busyAgents.length === 0 && ghostAgents.length === 0) return null;

  const hasBusy = busyAgents.length > 0;

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
            {busyAgents.length}
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

          {/* Active performers */}
          {busyAgents.map((agent) => {
            const rs = roomStyle(agent.session);
            const isSaiyan = saiyanTargets.has(agent.target);
            const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
            return (
              <div
                key={`stage-${agent.target}`}
                className="relative flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl cursor-pointer transition-all duration-200 hover:scale-110 hover:-translate-y-1"
                style={{ minWidth: 76 }}
                onMouseEnter={(e) => showPreview(agent, rs.accent, rs.label, e)}
                onMouseLeave={() => hidePreview()}
                onClick={(e) => onAgentClick(agent, rs.accent, rs.label, e)}
              >
                <div
                  className="absolute -top-1 left-1/2 -translate-x-1/2 w-12 h-16 pointer-events-none"
                  style={{ background: `radial-gradient(ellipse at 50% 0%, ${rs.accent}12 0%, transparent 70%)` }}
                />
                <svg viewBox="-40 -50 80 80" width={56} height={56} overflow="visible">
                  <AgentAvatar
                    name={agent.name}
                    target={agent.target}
                    status={agent.status}
                    preview={agent.preview}
                    accent={rs.accent}
                    saiyan={isSaiyan}
                    onClick={() => {}}
                  />
                </svg>
                <span className="text-[10px] font-semibold truncate max-w-[76px] text-center" style={{ color: rs.accent }}>
                  {displayName}
                </span>
                {isSaiyan && (
                  <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-400">⚡</span>
                )}
              </div>
            );
          })}

          {/* Ghost agents — greyed out recent performers */}
          {ghostAgents.map((agent) => {
            const rs = roomStyle(agent.session);
            const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
            return (
              <div
                key={`ghost-${agent.target}`}
                className="relative flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl cursor-pointer transition-all duration-200 hover:scale-105 hover:opacity-60"
                style={{ minWidth: 76, opacity: 0.3, filter: "grayscale(0.7)" }}
                onMouseEnter={(e) => showPreview(agent, rs.accent, rs.label, e)}
                onMouseLeave={() => hidePreview()}
                onClick={(e) => onAgentClick(agent, rs.accent, rs.label, e)}
              >
                <svg viewBox="-40 -50 80 80" width={56} height={56} overflow="visible">
                  <AgentAvatar
                    name={agent.name}
                    target={agent.target}
                    status={agent.status}
                    preview={agent.preview}
                    accent={rs.accent}
                    saiyan={false}
                    onClick={() => {}}
                  />
                </svg>
                <span className="text-[10px] font-semibold truncate max-w-[76px] text-center" style={{ color: "#64748B" }}>
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
