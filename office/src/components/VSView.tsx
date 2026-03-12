import { memo, useState, useMemo, useCallback } from "react";
import { VSAgentPanel } from "./VSAgentPanel";
import { AgentAvatar } from "./AgentAvatar";
import { agentColor, roomStyle } from "../lib/constants";
import type { AgentState } from "../lib/types";

/* ── Agent Picker (reuses JumpOverlay style) ── */

function AgentPicker({ agents, onSelect, onClose }: {
  agents: AgentState[];
  onSelect: (agent: AgentState) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return agents;
    const q = query.toLowerCase().trim();
    return agents.filter(a => {
      const haystack = `${a.name} ${a.session} ${a.target}`.toLowerCase();
      return q.split(/\s+/).every(word => haystack.includes(word));
    });
  }, [agents, query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered.length > 0) { onSelect(filtered[selectedIdx]); onClose(); }
      return;
    }
  }, [filtered, selectedIdx, onSelect, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ background: "rgba(2,2,8,0.85)", backdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col w-full max-w-[480px] rounded-xl border border-cyan-400/15 shadow-2xl overflow-hidden"
        style={{ background: "#0a0a0f", maxHeight: "60vh" }}
      >
        {/* Search */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <span className="text-amber-400 text-sm">VS</span>
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-white/90 outline-none caret-cyan-400 font-mono text-sm [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
            style={{ WebkitAppearance: "none" as const }}
            placeholder="Pick an oracle..."
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <span className="text-[9px] text-white/20 font-mono">{filtered.length}</span>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-white/30 text-sm font-mono">No match</div>
          )}
          {filtered.map((agent, i) => {
            const accent = agentColor(agent.name);
            const style = roomStyle(agent.session);
            const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
            const statusColor = agent.status === "busy" ? "#ffa726" : agent.status === "ready" ? "#22C55E" : "#555";
            const isSelected = i === selectedIdx;
            return (
              <div
                key={agent.target}
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors"
                style={{
                  background: isSelected ? `${accent}15` : "transparent",
                  borderLeft: isSelected ? `3px solid ${accent}` : "3px solid transparent",
                }}
                onClick={() => { onSelect(agent); onClose(); }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <div style={{ width: 28, height: 28 }} className="flex-shrink-0">
                  <svg viewBox="-40 -50 80 80" width={28} height={28} overflow="visible">
                    <AgentAvatar name={agent.name} target={agent.target} status={agent.status} preview="" accent={accent} onClick={() => {}} />
                  </svg>
                </div>
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: statusColor, boxShadow: agent.status !== "idle" ? `0 0 4px ${statusColor}` : undefined }}
                />
                <span className="text-sm font-mono font-semibold truncate" style={{ color: isSelected ? accent : "#cdd6f4" }}>
                  {displayName}
                </span>
                <span className="text-[10px] font-mono text-white/20 ml-auto flex-shrink-0">{style.label}</span>
                <span
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{
                    background: agent.status === "busy" ? "#ffa72618" : agent.status === "ready" ? "#22C55E14" : "rgba(255,255,255,0.04)",
                    color: statusColor,
                  }}
                >
                  {agent.status}
                </span>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-1.5 bg-[#08080c] border-t border-white/[0.04] text-[8px] font-mono text-white/20">
          <kbd className="text-white/30">↑↓</kbd> navigate · <kbd className="text-white/30">Enter</kbd> select · <kbd className="text-white/30">Esc</kbd> close
        </div>
      </div>
    </div>
  );
}

/* ── VS View ── */

interface VSViewProps {
  agents: AgentState[];
  send: (msg: object) => void;
}

export const VSView = memo(function VSView({ agents, send }: VSViewProps) {
  const [leftAgent, setLeftAgent] = useState<AgentState | null>(null);
  const [rightAgent, setRightAgent] = useState<AgentState | null>(null);
  const [picking, setPicking] = useState<"left" | "right" | null>(null);

  // Auto-select first two busy/ready agents on mount
  if (!leftAgent && agents.length > 0) {
    const busy = agents.filter(a => a.status === "busy");
    setLeftAgent(busy[0] || agents[0]);
  }
  if (!rightAgent && agents.length > 1) {
    const busy = agents.filter(a => a.status === "busy" && a.target !== leftAgent?.target);
    setRightAgent(busy[0] || agents.find(a => a.target !== leftAgent?.target) || null);
  }

  // Keep agents up to date (status changes)
  const left = useMemo(() => leftAgent ? agents.find(a => a.target === leftAgent.target) || leftAgent : null, [agents, leftAgent]);
  const right = useMemo(() => rightAgent ? agents.find(a => a.target === rightAgent.target) || rightAgent : null, [agents, rightAgent]);

  const handlePick = useCallback((agent: AgentState) => {
    if (picking === "left") setLeftAgent(agent);
    else if (picking === "right") setRightAgent(agent);
    setPicking(null);
  }, [picking]);

  return (
    <div className="flex flex-col sm:flex-row" style={{ height: "calc(100vh - 72px)" }}>
      {/* Left panel */}
      <VSAgentPanel
        agent={left}
        send={send}
        onPickAgent={() => setPicking("left")}
      />

      {/* VS Divider */}
      <div
        className="hidden sm:flex flex-col items-center justify-center"
        style={{ background: "#0d0d16", width: 40 }}
      >
        <div
          className="text-[18px] font-black tracking-[2px] font-mono select-none"
          style={{
            color: "#fbbf24",
            animation: "vsPulse 2s ease-in-out infinite",
            writingMode: "vertical-lr",
            textOrientation: "mixed",
          }}
        >
          VS
        </div>
      </div>

      {/* Mobile VS divider */}
      <div className="sm:hidden flex items-center justify-center py-1.5" style={{ background: "#0d0d16" }}>
        <span className="text-[14px] font-black tracking-[4px] font-mono" style={{ color: "#fbbf24", animation: "vsPulse 2s ease-in-out infinite" }}>
          VS
        </span>
      </div>

      {/* Right panel */}
      <VSAgentPanel
        agent={right}
        send={send}
        onPickAgent={() => setPicking("right")}
      />

      {/* Agent picker overlay */}
      {picking && (
        <AgentPicker
          agents={agents}
          onSelect={handlePick}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
});
