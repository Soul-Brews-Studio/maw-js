import { memo, useState, useEffect, type ReactNode } from "react";
import { apiUrl } from "../lib/api";

interface StatusBarProps {
  connected: boolean;
  agentCount: number;
  sessionCount: number;
  activeView?: string;
  askCount?: number;
  onInbox?: () => void;
  onJump?: () => void;
  muted?: boolean;
  onToggleMute?: () => void;
  children?: ReactNode;
}

const NAV_ITEMS = [
  { href: "#fleet", label: "Fleet", id: "fleet" },
  { href: "#office", label: "Office", id: "office" },
  { href: "#orbital", label: "Orbital", id: "orbital" },
  { href: "#terminal", label: "Terminal", id: "terminal" },
  { href: "#chat", label: "Chat", id: "chat" },
  { href: "#config", label: "Config", id: "config" },
];

const isTouch = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

interface RateData { inputTokens: number; outputTokens: number; totalTokens: number; totalPerMin: number; inputPerMin: number; outputPerMin: number; turns: number }

function useTokenRate() {
  const [lastHourRate, setLastHourRate] = useState<RateData | null>(null);
  useEffect(() => {
    const fetch_ = () => {
      fetch(apiUrl("/api/tokens/rate?mode=window&window=3600")).then(r => r.json()).then(d => setLastHourRate(d)).catch(() => {});
    };
    fetch_();
    const iv = setInterval(fetch_, 30000);
    return () => clearInterval(iv);
  }, []);
  return { lastHourRate };
}

export const StatusBar = memo(function StatusBar({ connected, agentCount, sessionCount, activeView = "office", askCount = 0, onInbox, onJump, muted, onToggleMute, children }: StatusBarProps) {
  const { lastHourRate } = useTokenRate();
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 mx-4 sm:mx-6 mt-3 px-4 sm:px-6 py-2.5 rounded-2xl bg-black/50 backdrop-blur-xl border border-white/[0.06] shadow-[0_4px_30px_rgba(0,0,0,0.4)]">
      <a href="#office" className="text-base sm:text-lg font-bold tracking-[4px] sm:tracking-[6px] text-cyan-400 uppercase whitespace-nowrap hover:text-cyan-300 transition-colors">
        Oracle Office
      </a>

      <span className="flex items-center gap-1.5 text-sm text-white/70">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-emerald-400 shadow-[0_0_6px_#4caf50]" : "bg-red-400 animate-pulse"}`} />
        {connected ? "LIVE" : "..."}
      </span>

      <span className="text-sm text-white/70 whitespace-nowrap">
        <strong className="text-cyan-400">{agentCount}</strong> agents
      </span>
      <span className="text-sm text-white/70 whitespace-nowrap">
        <strong className="text-purple-400">{sessionCount}</strong> rooms
      </span>
      <span className="text-[10px] text-white/20 font-mono whitespace-nowrap">
        v{__MAW_VERSION__} · {__MAW_BUILD__}
      </span>

      {lastHourRate && lastHourRate.totalTokens > 0 && (
        <span className="text-[10px] font-mono whitespace-nowrap flex items-center gap-1" title={`Last 60min — ${formatTokens(lastHourRate.inputTokens)} in · ${formatTokens(lastHourRate.outputTokens)} out · ${lastHourRate.turns} turns`}>
          <span className="text-amber-400/70">{formatTokens(lastHourRate.totalPerMin)}</span>
          <span className="text-white/15">tok/min</span>
        </span>
      )}

      {/* View-specific controls injected by parent */}
      {children}

      {onToggleMute && (
        <button
          onClick={onToggleMute}
          className="px-2.5 py-1.5 rounded-lg text-xs font-mono active:scale-95 transition-all whitespace-nowrap"
          style={{
            background: muted ? "rgba(239,83,80,0.15)" : "rgba(76,175,80,0.15)",
            color: muted ? "#ef5350" : "#4caf50",
            border: `1px solid ${muted ? "rgba(239,83,80,0.25)" : "rgba(76,175,80,0.25)"}`,
          }}
          title={muted ? "Unmute sounds" : "Mute sounds"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      )}

      {isTouch && onJump && (
        <button
          onClick={onJump}
          className="px-3 py-1.5 rounded-lg text-xs font-mono font-bold active:scale-95 transition-all whitespace-nowrap"
          style={{ background: "rgba(34,211,238,0.15)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.25)" }}
          title="Jump to agent (⌘J)"
        >
          ⌘J
        </button>
      )}

      <nav className={`${isTouch && onJump ? "" : "ml-auto "}flex items-center gap-3 sm:gap-4 text-sm`}>
        {onInbox && (
          <button onClick={onInbox} className="relative transition-colors whitespace-nowrap text-white/50 hover:text-white/80 cursor-pointer" title="Inbox (i)">
            Inbox
            {askCount > 0 && (
              <span className="absolute -top-1.5 -right-3 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold text-white bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]">
                {askCount}
              </span>
            )}
          </button>
        )}
        {NAV_ITEMS.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={`transition-colors whitespace-nowrap ${
              activeView === item.id
                ? "text-cyan-400 font-bold"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </header>
  );
});
