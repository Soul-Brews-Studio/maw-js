import { memo, useState, useEffect, useRef, useMemo } from "react";
import { ansiToHtml, processCapture } from "../lib/ansi";
import { roomStyle, agentColor } from "../lib/constants";
import { apiUrl } from "../lib/api";
import { useFps } from "./FpsCounter";
import { useFleetStore } from "../lib/store";
import type { AgentState, Session } from "../lib/types";

/** Extract leading number from session name: "08-neo" → 8, "0" → 0 */
function sessionNum(name: string): number {
  const m = name.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

interface OverviewGridProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
}

/** Single terminal tile — polls /api/capture for live content */
const OverviewTile = memo(function OverviewTile({
  agent,
  accent,
  shortcutKey,
  onClick,
}: {
  agent: AgentState;
  accent: string;
  shortcutKey?: number;
  onClick: () => void;
}) {
  const [content, setContent] = useState("");
  const tileRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);

  const displayName = agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
  const isBusy = agent.status === "busy";
  const statusColor = isBusy ? "#ffa726" : agent.status === "ready" ? "#22C55E" : "#555";

  // IntersectionObserver — only poll when visible
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = tileRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Poll capture when visible
  useEffect(() => {
    if (!visible) return;
    activeRef.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!activeRef.current) return;
      try {
        const res = await fetch(apiUrl(`/api/capture?target=${encodeURIComponent(agent.target)}`));
        const data = await res.json();
        if (activeRef.current) setContent(data.content || "");
      } catch {}
      if (activeRef.current) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => { activeRef.current = false; clearTimeout(timer); };
  }, [agent.target, visible]);

  const trimmed = useMemo(() => processCapture(content), [content]);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [trimmed]);

  return (
    <div
      ref={tileRef}
      className="flex flex-col rounded-xl overflow-hidden cursor-pointer transition-all duration-150 hover:scale-[1.01]"
      style={{
        background: "#0c0c14",
        border: `1px solid ${isBusy ? accent + "40" : "rgba(255,255,255,0.06)"}`,
        boxShadow: isBusy ? `0 0 20px ${accent}10` : "0 2px 8px rgba(0,0,0,0.3)",
      }}
      onClick={onClick}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-3 py-2"
        style={{ background: `${accent}08`, borderBottom: `1px solid ${accent}15` }}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{
            background: statusColor,
            boxShadow: agent.status !== "idle" ? `0 0 6px ${statusColor}` : undefined,
          }}
        />
        <span
          className="text-xs font-bold tracking-[1px] truncate"
          style={{ color: accent }}
        >
          {displayName}
        </span>
        {shortcutKey != null && (
          <kbd className="text-[9px] font-mono px-1 py-0.5 rounded" style={{ background: `${accent}15`, color: `${accent}60` }}>
            {shortcutKey}
          </kbd>
        )}
        <span className="text-[9px] font-mono text-white/25">{agent.session}</span>
        <span
          className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{
            background: isBusy ? "#ffa72618" : agent.status === "ready" ? "#22C55E14" : "rgba(255,255,255,0.04)",
            color: statusColor,
          }}
        >
          {agent.status}
        </span>
      </div>

      {/* Terminal content */}
      <div
        ref={termRef}
        className="flex-1 px-2 py-1.5 overflow-y-auto overflow-x-hidden font-mono text-[9px] leading-[1.35] text-[#cdd6f4] whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
        style={{ background: "#08080c", minHeight: 180, maxHeight: 300 }}
        dangerouslySetInnerHTML={{ __html: ansiToHtml(trimmed) }}
      />
    </div>
  );
});

export const OverviewGrid = memo(function OverviewGrid({
  sessions,
  agents,
  connected,
  send,
  onSelectAgent,
}: OverviewGridProps) {
  const fps = useFps();

  const grouped = useFleetStore((s) => s.grouped);
  const busyCount = agents.filter(a => a.status === "busy").length;
  const readyCount = agents.filter(a => a.status === "ready").length;
  const idleCount = agents.length - busyCount - readyCount;

  // Group agents by session, with optional solo oracle merging
  const sessionGroups = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) {
      const arr = map.get(a.session) || [];
      arr.push(a);
      map.set(a.session, arr);
    }
    const entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    if (!grouped) return entries;

    const soloAgents: AgentState[] = [];
    const multi: [string, AgentState[]][] = [];
    for (const [name, sessionAgents] of entries) {
      if (sessionAgents.length <= 1) soloAgents.push(...sessionAgents);
      else multi.push([name, sessionAgents]);
    }
    const result: [string, AgentState[]][] = [];
    if (soloAgents.length > 0) result.push(["_oracles", soloAgents]);
    result.push(...multi);
    return result;
  }, [agents, grouped]);

  return (
    <div className="relative w-full min-h-screen" style={{ background: "#0a0a12" }}>
      {/* Summary bar */}
      <div className="max-w-[1600px] mx-auto flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-4 text-sm font-mono">
          <span className="text-white/30 text-[10px] tracking-[4px] uppercase">Oracle Overview</span>
          <span className="text-white/60">{sessions.length} rooms</span>
          <span className="text-white/20">/</span>
          <span className="text-white/60">{agents.length} agents</span>
          <span className="text-white/20">/</span>
          <span style={{ color: fps >= 50 ? "#4caf50" : fps >= 30 ? "#ffa726" : "#ef5350" }}>{fps} fps</span>
        </div>
        <div className="flex items-center gap-5 text-sm font-mono">
          {busyCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_#ffa726] animate-pulse" />
              <span className="text-amber-400">{busyCount} busy</span>
            </span>
          )}
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_4px_#4caf50]" />
            <span className="text-emerald-400">{readyCount} ready</span>
          </span>
          {idleCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-white/20" />
              <span className="text-white/30">{idleCount} idle</span>
            </span>
          )}
          <span className="text-[9px] text-white/15 font-mono">J to jump</span>
        </div>
      </div>

      {/* Session groups */}
      <div className="max-w-[1600px] mx-auto px-6 py-6 flex flex-col gap-6">
        {sessionGroups.map(([sessionName, sessionAgents]) => {
          const isOracles = sessionName === "_oracles";
          const style = isOracles ? { accent: "#7e57c2", floor: "#1a1428", wall: "#120e1e", label: "Oracles" } : roomStyle(sessionName);
          const hasBusy = sessionAgents.some(a => a.status === "busy");
          const num = sessionNum(sessionName);
          const displayName = style.label || sessionName;
          return (
            <section key={sessionName}>
              {/* Session header */}
              <div className="flex items-center gap-3 mb-3 px-1">
                <kbd
                  className="w-6 h-6 flex items-center justify-center rounded text-[10px] font-bold font-mono flex-shrink-0"
                  style={{ background: `${style.accent}15`, color: `${style.accent}80`, border: `1px solid ${style.accent}25` }}
                >
                  {isOracles ? "★" : num >= 0 ? num : "·"}
                </kbd>
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{
                    background: hasBusy ? "#ffa726" : "#22C55E",
                    boxShadow: hasBusy ? "0 0 8px #ffa726" : "0 0 4px #22C55E",
                  }}
                />
                <h3
                  className="text-sm font-bold tracking-[3px] uppercase"
                  style={{ color: style.accent }}
                >
                  {displayName}
                </h3>
                <span
                  className="text-[10px] font-mono px-2 py-0.5 rounded"
                  style={{ background: `${style.accent}18`, color: style.accent }}
                >
                  {sessionAgents.length} agent{sessionAgents.length > 1 ? "s" : ""}
                </span>
              </div>

              {/* Agent tiles grid */}
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}
              >
                {sessionAgents.map((agent, i) => (
                  <OverviewTile
                    key={agent.target}
                    agent={agent}
                    accent={style.accent}
                    shortcutKey={i + 1}
                    onClick={() => onSelectAgent(agent)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {agents.length === 0 && (
        <div className="flex items-center justify-center h-64 text-white/20 font-mono text-sm">
          No agents online
        </div>
      )}

    </div>
  );
});
