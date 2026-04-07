import { memo, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { apiUrl } from "../lib/api";
import { agentColor, roomStyle, guessCommand } from "../lib/constants";
import { describeActivity, type FeedEvent } from "../lib/feed";
import { useFleetStore } from "../lib/store";
import type { AgentState, Session, AgentEvent } from "../lib/types";

// ─── Token types ────────────────────────────────────────────────────
interface TokenSession {
  session: string;
  project: string;
  input: number;
  output: number;
  cache: number;
  total: number;
  turns: number;
  date: string;
}

interface TokenRate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalPerMin: number;
  inputPerMin: number;
  outputPerMin: number;
  turns: number;
}

// ─── Helpers ────────────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatCost(tokens: number): string {
  // Rough estimate: ~$3/1M input, ~$15/1M output (blended ~$8/1M)
  const cost = (tokens / 1_000_000) * 8;
  if (cost < 0.01) return "<$0.01";
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(1)}`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

const STATUS_CONFIG = {
  busy: { color: "#fbbf24", bg: "rgba(251,191,36,0.12)", glow: "0 0 8px rgba(251,191,36,0.4)", label: "BUSY", dot: "bg-amber-400 animate-pulse shadow-[0_0_6px_#ffa726]" },
  ready: { color: "#22c55e", bg: "rgba(34,197,94,0.10)", glow: "0 0 6px rgba(34,197,94,0.3)", label: "READY", dot: "bg-emerald-400 shadow-[0_0_4px_#4caf50]" },
  idle: { color: "#64748b", bg: "rgba(100,116,139,0.06)", glow: "none", label: "IDLE", dot: "bg-white/20" },
};

// ─── Status Overview Panel ──────────────────────────────────────────
const AgentStatusCard = memo(function AgentStatusCard({ agent, feedEvent, onSelect, onCommand }: {
  agent: AgentState;
  feedEvent?: FeedEvent;
  onSelect: (agent: AgentState) => void;
  onCommand: (target: string, text: string) => void;
}) {
  const sc = STATUS_CONFIG[agent.status];
  const color = agentColor(agent.name);
  const room = roomStyle(agent.session);

  return (
    <div
      className="relative rounded-xl border transition-all duration-300 cursor-pointer hover:scale-[1.02] group"
      style={{
        background: sc.bg,
        borderColor: `${sc.color}33`,
        boxShadow: sc.glow,
      }}
      onClick={() => onSelect(agent)}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-1">
        <div className="relative flex-shrink-0">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: `${color}22`, color, border: `2px solid ${color}55` }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#0a0a14] ${sc.dot}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white/90 truncate">{agent.name}</span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md whitespace-nowrap" style={{ background: `${sc.color}15`, color: sc.color }}>
              {sc.label}
            </span>
          </div>
          <div className="text-[10px] text-white/30 font-mono truncate">
            {room.label} · {agent.target}
          </div>
        </div>
      </div>

      {/* Activity */}
      <div className="px-3 pb-2.5 mt-1">
        {feedEvent ? (
          <div className="text-[11px] text-white/50 truncate font-mono">
            {describeActivity(feedEvent)}
          </div>
        ) : agent.preview ? (
          <div className="text-[11px] text-white/30 truncate font-mono italic">
            {agent.preview}
          </div>
        ) : (
          <div className="text-[11px] text-white/15 font-mono">no activity</div>
        )}
      </div>

      {/* Project badge */}
      {agent.project && (
        <div className="absolute top-2.5 right-2.5">
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-white/25 truncate max-w-[80px] inline-block">
            {agent.project}
          </span>
        </div>
      )}
    </div>
  );
});

function StatusOverview({ agents, feedActive, agentFeedLog, onSelectAgent, send }: {
  agents: AgentState[];
  feedActive: Map<string, FeedEvent>;
  agentFeedLog: Map<string, FeedEvent[]>;
  onSelectAgent: (agent: AgentState) => void;
  send: (msg: object) => void;
}) {
  const busyCount = agents.filter(a => a.status === "busy").length;
  const readyCount = agents.filter(a => a.status === "ready").length;
  const idleCount = agents.length - busyCount - readyCount;

  const handleCommand = useCallback((target: string, text: string) => {
    send({ type: "send", target, text: text + "\n" });
  }, [send]);

  // Find latest feed event per agent
  const latestFeed = useMemo(() => {
    const map = new Map<string, FeedEvent>();
    for (const [oracle, events] of agentFeedLog) {
      if (events.length > 0) map.set(oracle, events[0]);
    }
    return map;
  }, [agentFeedLog]);

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-1">
        <h2 className="text-sm font-bold tracking-widest text-white/60 uppercase">Status</h2>
        <div className="flex items-center gap-3 ml-auto">
          {busyCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-mono">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_6px_#ffa726]" />
              <span className="text-amber-400 font-bold">{busyCount}</span>
              <span className="text-white/25">busy</span>
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-emerald-400 font-bold">{readyCount}</span>
            <span className="text-white/25">ready</span>
          </span>
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-white/20" />
            <span className="text-white/30 font-bold">{idleCount}</span>
            <span className="text-white/25">idle</span>
          </span>
        </div>
      </div>

      {/* Agent grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {agents.map(agent => (
          <AgentStatusCard
            key={agent.target}
            agent={agent}
            feedEvent={latestFeed.get(agent.name.replace(/-oracle$/, ""))}
            onSelect={onSelectAgent}
            onCommand={handleCommand}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Token Tracking Panel ───────────────────────────────────────────
function TokenTracking() {
  const [sessions, setSessions] = useState<TokenSession[]>([]);
  const [rate, setRate] = useState<TokenRate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTokens = () => {
      Promise.all([
        fetch(apiUrl("/api/tokens")).then(r => r.ok ? r.json() : []),
        fetch(apiUrl("/api/tokens/rate?mode=window&window=3600")).then(r => r.ok ? r.json() : null),
      ]).then(([tokData, rateData]) => {
        setSessions(Array.isArray(tokData) ? tokData : tokData?.sessions || []);
        setRate(rateData);
        setLoading(false);
      }).catch(() => setLoading(false));
    };
    fetchTokens();
    const iv = setInterval(fetchTokens, 30_000);
    return () => clearInterval(iv);
  }, []);

  // Aggregate by project
  const byProject = useMemo(() => {
    const map = new Map<string, { input: number; output: number; cache: number; total: number; turns: number; sessions: number }>();
    for (const s of sessions) {
      const key = s.project || "unknown";
      const prev = map.get(key) || { input: 0, output: 0, cache: 0, total: 0, turns: 0, sessions: 0 };
      map.set(key, {
        input: prev.input + s.input,
        output: prev.output + s.output,
        cache: prev.cache + s.cache,
        total: prev.total + s.total,
        turns: prev.turns + s.turns,
        sessions: prev.sessions + 1,
      });
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }, [sessions]);

  const grandTotal = useMemo(() => sessions.reduce((acc, s) => acc + s.total, 0), [sessions]);
  const grandInput = useMemo(() => sessions.reduce((acc, s) => acc + s.input, 0), [sessions]);
  const grandOutput = useMemo(() => sessions.reduce((acc, s) => acc + s.output, 0), [sessions]);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold tracking-widest text-white/60 uppercase px-1">Tokens</h2>

      {/* Live rate + totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Burn Rate" value={rate ? `${formatTokens(rate.totalPerMin)}/min` : "—"} accent="#fbbf24" sub={rate ? `${rate.turns} turns/hr` : ""} />
        <StatCard label="Total" value={formatTokens(grandTotal)} accent="#22d3ee" sub={formatCost(grandTotal)} />
        <StatCard label="Input" value={formatTokens(grandInput)} accent="#818cf8" sub={`${sessions.length} sessions`} />
        <StatCard label="Output" value={formatTokens(grandOutput)} accent="#f472b6" sub={rate ? `${formatTokens(rate.outputPerMin)}/min` : ""} />
      </div>

      {/* By project table */}
      {!loading && byProject.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-white/30 border-b border-white/[0.06]">
                <th className="text-left py-2 px-3 font-normal">Project</th>
                <th className="text-right py-2 px-3 font-normal">Input</th>
                <th className="text-right py-2 px-3 font-normal">Output</th>
                <th className="text-right py-2 px-3 font-normal">Total</th>
                <th className="text-right py-2 px-3 font-normal">Cost</th>
                <th className="text-right py-2 px-3 font-normal">Turns</th>
              </tr>
            </thead>
            <tbody>
              {byProject.slice(0, 15).map(([project, data]) => {
                const pct = grandTotal > 0 ? (data.total / grandTotal) * 100 : 0;
                return (
                  <tr key={project} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-1 h-4 rounded-full" style={{ background: agentColor(project), opacity: 0.6 }} />
                        <span className="text-white/70 truncate max-w-[160px]">{project}</span>
                      </div>
                    </td>
                    <td className="text-right py-2 px-3 text-indigo-400/70">{formatTokens(data.input)}</td>
                    <td className="text-right py-2 px-3 text-pink-400/70">{formatTokens(data.output)}</td>
                    <td className="text-right py-2 px-3 text-cyan-400/80 font-bold">{formatTokens(data.total)}</td>
                    <td className="text-right py-2 px-3 text-amber-400/60">{formatCost(data.total)}</td>
                    <td className="text-right py-2 px-3 text-white/30">{data.turns}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {loading && <div className="text-xs text-white/20 font-mono px-1">Loading token data...</div>}
    </div>
  );
}

function StatCard({ label, value, accent, sub }: { label: string; value: string; accent: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] px-4 py-3" style={{ background: `${accent}08` }}>
      <div className="text-[10px] text-white/30 font-mono uppercase tracking-wider">{label}</div>
      <div className="text-xl font-bold font-mono mt-1" style={{ color: accent }}>{value}</div>
      {sub && <div className="text-[10px] text-white/20 font-mono mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Command Center Panel ───────────────────────────────────────────
function CommandCenter({ agents, send }: { agents: AgentState[]; send: (msg: object) => void }) {
  const [selectedTarget, setSelectedTarget] = useState("");
  const [commandText, setCommandText] = useState("");
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [history, setHistory] = useState<{ ts: number; target: string; text: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const sendCommand = useCallback(() => {
    if (!commandText.trim()) return;

    const targets = broadcastMode
      ? agents.filter(a => a.status === "busy" || a.status === "ready").map(a => a.target)
      : selectedTarget ? [selectedTarget] : [];

    if (targets.length === 0) return;

    for (const target of targets) {
      send({ type: "send", target, text: commandText + "\n" });
    }

    setHistory(prev => [
      { ts: Date.now(), target: broadcastMode ? `ALL (${targets.length})` : selectedTarget, text: commandText },
      ...prev.slice(0, 19),
    ]);
    setCommandText("");
    inputRef.current?.focus();
  }, [commandText, selectedTarget, broadcastMode, agents, send]);

  const quickActions = useMemo(() => [
    { label: "Wake All", icon: "▶", color: "#22c55e", action: () => { for (const a of agents) { if (a.status === "idle") send({ type: "wake", target: a.target, command: guessCommand(a.name) }); } } },
    { label: "Sleep All", icon: "⏸", color: "#fbbf24", action: () => { if (confirm("Sleep all busy agents?")) { for (const a of agents) { if (a.status === "busy") send({ type: "sleep", target: a.target }); } } } },
    { label: "/recap", icon: "📋", color: "#818cf8", action: () => { if (selectedTarget) send({ type: "send", target: selectedTarget, text: "/recap\n" }); } },
    { label: "/compact", icon: "📦", color: "#f472b6", action: () => { if (selectedTarget) send({ type: "send", target: selectedTarget, text: "/compact\n" }); } },
  ], [agents, send, selectedTarget]);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold tracking-widest text-white/60 uppercase px-1">Command Center</h2>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        {quickActions.map(qa => (
          <button
            key={qa.label}
            className="px-3 py-2 rounded-lg text-xs font-mono font-bold active:scale-95 transition-all flex items-center gap-1.5"
            style={{ background: `${qa.color}15`, color: qa.color, border: `1px solid ${qa.color}25` }}
            onClick={qa.action}
          >
            <span>{qa.icon}</span>
            {qa.label}
          </button>
        ))}
      </div>

      {/* Command input */}
      <div className="rounded-xl border border-white/[0.08] p-4 space-y-3" style={{ background: "rgba(255,255,255,0.02)" }}>
        <div className="flex items-center gap-3">
          {/* Target selector */}
          <select
            value={broadcastMode ? "__broadcast__" : selectedTarget}
            onChange={(e) => {
              if (e.target.value === "__broadcast__") {
                setBroadcastMode(true);
              } else {
                setBroadcastMode(false);
                setSelectedTarget(e.target.value);
              }
            }}
            className="bg-black/50 border border-white/[0.08] rounded-lg px-3 py-2 text-xs font-mono text-white/70 outline-none focus:border-cyan-400/30 min-w-[180px]"
          >
            <option value="">Select agent...</option>
            <option value="__broadcast__">Broadcast (all active)</option>
            {agents.map(a => (
              <option key={a.target} value={a.target}>
                {a.status === "busy" ? "● " : a.status === "ready" ? "○ " : "· "}{a.name}
              </option>
            ))}
          </select>

          {/* Command input */}
          <div className="flex-1 flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              placeholder={broadcastMode ? "Send to all active agents..." : "Type command or message..."}
              value={commandText}
              onChange={(e) => setCommandText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendCommand(); }}
              className="flex-1 bg-black/50 border border-white/[0.08] rounded-lg px-3 py-2 text-xs font-mono text-white/80 outline-none focus:border-cyan-400/30 placeholder:text-white/15"
            />
            <button
              onClick={sendCommand}
              disabled={!commandText.trim() || (!selectedTarget && !broadcastMode)}
              className="px-4 py-2 rounded-lg text-xs font-mono font-bold transition-all active:scale-95 disabled:opacity-30"
              style={{ background: "rgba(34,211,238,0.15)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.25)" }}
            >
              Send
            </button>
          </div>
        </div>

        {/* Per-agent quick controls */}
        <div className="flex flex-wrap gap-1.5">
          {agents.filter(a => a.status === "busy" || a.status === "ready").slice(0, 12).map(a => {
            const sc = STATUS_CONFIG[a.status];
            return (
              <button
                key={a.target}
                className="px-2 py-1 rounded-md text-[10px] font-mono transition-all active:scale-95"
                style={{
                  background: selectedTarget === a.target ? `${sc.color}25` : "rgba(255,255,255,0.03)",
                  color: selectedTarget === a.target ? sc.color : "rgba(255,255,255,0.3)",
                  border: `1px solid ${selectedTarget === a.target ? `${sc.color}40` : "transparent"}`,
                }}
                onClick={() => { setBroadcastMode(false); setSelectedTarget(a.target); inputRef.current?.focus(); }}
              >
                {a.name.replace(/-oracle$/, "")}
              </button>
            );
          })}
        </div>
      </div>

      {/* Command history */}
      {history.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-white/20 font-mono uppercase tracking-wider px-1">Recent Commands</div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {history.map((h, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] font-mono px-2 py-1 rounded-md bg-white/[0.02]">
                <span className="text-white/15 flex-shrink-0">{timeAgo(h.ts)}</span>
                <span className="text-cyan-400/40 flex-shrink-0">{h.target.split(":")[0]?.replace(/^\d+-/, "")}</span>
                <span className="text-white/40 truncate">{h.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Activity Feed (bonus) ──────────────────────────────────────────
function ActivityFeed({ feedEvents }: { feedEvents: FeedEvent[] }) {
  const recent = useMemo(() => feedEvents.slice(-30).reverse(), [feedEvents]);

  if (recent.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-bold tracking-widest text-white/60 uppercase px-1">Live Feed</h2>
      <div className="rounded-xl border border-white/[0.06] overflow-hidden max-h-[300px] overflow-y-auto">
        <div className="divide-y divide-white/[0.03]">
          {recent.map((e, i) => {
            const color = agentColor(e.oracle);
            return (
              <div key={`${e.ts}-${i}`} className="flex items-start gap-2.5 px-3 py-2 hover:bg-white/[0.02] transition-colors">
                <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-bold" style={{ color: `${color}cc` }}>{e.oracle}</span>
                    <span className="text-[9px] text-white/15 font-mono">{e.project}</span>
                    <span className="text-[9px] text-white/10 font-mono ml-auto flex-shrink-0">{timeAgo(e.ts)}</span>
                  </div>
                  <div className="text-[11px] text-white/40 font-mono truncate">{describeActivity(e)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard View ────────────────────────────────────────────
interface DashboardViewProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
  eventLog: AgentEvent[];
  feedEvents: FeedEvent[];
  feedActive: Map<string, FeedEvent>;
  agentFeedLog: Map<string, FeedEvent[]>;
}

export const DashboardView = memo(function DashboardView({
  sessions, agents, connected, send, onSelectAgent, eventLog, feedEvents, feedActive, agentFeedLog,
}: DashboardViewProps) {
  return (
    <div className="relative z-10 px-4 sm:px-6 py-4 space-y-6 max-w-[1600px] mx-auto">
      {/* Status Overview */}
      <StatusOverview
        agents={agents}
        feedActive={feedActive}
        agentFeedLog={agentFeedLog}
        onSelectAgent={onSelectAgent}
        send={send}
      />

      {/* Two-column: Tokens + Command Center */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TokenTracking />
        <CommandCenter agents={agents} send={send} />
      </div>

      {/* Activity feed */}
      <ActivityFeed feedEvents={feedEvents} />
    </div>
  );
});
